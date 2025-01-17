import { addDomainToVercel } from "@/lib/api/domains";
import { handleAndReturnErrorResponse } from "@/lib/api/errors";
import { bulkCreateLinks, createLink, processLink } from "@/lib/api/links";
import { verifyQstashSignature } from "@/lib/cron/verify-qstash";
import { prisma } from "@/lib/prisma";
import { storage } from "@/lib/storage";
import { ProcessedLinkProps, WorkspaceProps } from "@/lib/types";
import { redis } from "@/lib/upstash";
import { linkMappingSchema } from "@/lib/zod/schemas/import-csv";
import { createLinkBodySchema } from "@/lib/zod/schemas/links";
import { randomBadgeColor } from "@/ui/links/tag-badge";
import {
  DEFAULT_LINK_PROPS,
  DUB_DOMAINS_ARRAY,
  getPrettyUrl,
  log,
  parseDateTime,
} from "@dub/utils";
import { NextResponse } from "next/server";
import Papa from "papaparse";
import { Readable } from "stream";
import { sendCsvImportEmails } from "./utils";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    const body = await req.json();
    await verifyQstashSignature(req, body);
    const { workspaceId, userId, id, url } = body;
    const mapping = linkMappingSchema.parse(body.mapping);

    if (!id || !url) throw new Error("Missing ID or URL for the import file");

    const mapper = (row: Record<string, string>) => {
      const linkUrl = getPrettyUrl(row[mapping.link]);

      return {
        ...Object.fromEntries(
          Object.entries(mapping).map(([key, value]) => [key, row[value]]),
        ),
        domain: linkUrl.split("/")[0],
        // domain.com/path/to/page => path/to/page
        key: linkUrl.split("/").slice(1).join("/") || "_root",
        createdAt: mapping.createdAt
          ? parseDateTime(row[mapping.createdAt])
          : undefined,
        tags: mapping.tags
          ? [
              ...new Set(
                row[mapping.tags]
                  ?.split(",")
                  .map((tag) => tag.trim())
                  .filter(Boolean),
              ),
            ]
          : undefined,
      };
    };

    let cursor = parseInt(
      (await redis.get(`import:csv:${workspaceId}:${id}:cursor`)) ?? "0",
    );

    let count = cursor; // Count the total number of links added

    const workspace = (await prisma.project.findUniqueOrThrow({
      where: { id: workspaceId },
    })) as WorkspaceProps;

    const response = await storage.fetch(url);

    const [tags, domains] = await Promise.all([
      prisma.tag.findMany({
        where: { projectId: workspace.id },
        select: { name: true },
      }),
      prisma.domain.findMany({
        where: { projectId: workspace.id },
        select: { slug: true },
      }),
    ]);

    const addedTags: string[] = [];
    const addedDomains: string[] = [];

    await new Promise((resolve, reject) => {
      Papa.parse(Readable.fromWeb(response.body as any), {
        header: true,
        skipEmptyLines: true,
        skipFirstNLines: cursor,
        worker: false,
        complete: resolve,
        error: reject,
        chunk: async (
          chunk: {
            data?: Record<string, string>[];
            errors: { message: string }[];
          },
          parser,
        ) => {
          parser.pause(); // Pause parsing until we finish processing this chunk

          const { data } = chunk;
          if (!data?.length) {
            console.warn("No data in CSV import chunk", chunk.errors);
            parser.resume();
            return;
          }

          // Find links that already exist in the workspace (we check matching of *both* domain and key below)
          const alreadyCreatedLinks = await prisma.link.findMany({
            where: {
              domain: {
                in: domains.map((domain) => domain.slug),
              },
              key: {
                in: data.map((row) => mapper(row).key),
              },
            },
            select: {
              domain: true,
              key: true,
            },
          });

          // Find which links still need to be created
          const linksToCreate = data
            .map((row) => mapper(row))
            .filter(
              (link) =>
                !alreadyCreatedLinks.some(
                  (l) => l.domain === link.domain && l.key === link.key,
                ) && link.key !== "_root",
            );

          const selectedTags = [
            ...new Set(
              linksToCreate
                .map(({ tags }) => tags)
                .flat()
                .filter(Boolean),
            ),
          ] as string[];

          // Find tags that need to be added to the workspace
          const tagsNotInWorkspace = selectedTags.filter(
            (tag) =>
              !tags.find((t) => t.name.toLowerCase() === tag.toLowerCase()) &&
              !addedTags.find((t) => t.toLowerCase() === tag.toLowerCase()),
          );

          // Add missing tags to the workspace
          if (tagsNotInWorkspace.length > 0) {
            await prisma.tag.createMany({
              data: tagsNotInWorkspace.map((tag) => ({
                name: tag,
                color: randomBadgeColor(),
                projectId: workspace.id,
              })),
              skipDuplicates: true,
            });
          }

          addedTags.push(...tagsNotInWorkspace);

          const selectedDomains = [
            ...new Set(linksToCreate.map(({ domain }) => domain)),
          ];

          // Find domains that need to be added to the workspace
          const domainsNotInWorkspace = selectedDomains.filter(
            (domain) =>
              !domains?.find((d) => d.slug === domain) &&
              !DUB_DOMAINS_ARRAY.includes(domain) &&
              !addedDomains.includes(domain),
          );

          // Add missing domains to the workspace
          if (domainsNotInWorkspace.length > 0) {
            await Promise.allSettled([
              // create domains in DB
              prisma.domain.createMany({
                data: domainsNotInWorkspace.map((domain) => ({
                  slug: domain,
                  projectId: workspace.id,
                  primary: false,
                })),
                skipDuplicates: true,
              }),
              // create domains in Vercel
              domainsNotInWorkspace.map((domain) => addDomainToVercel(domain)),
              // create links for domains
              domainsNotInWorkspace.map((domain) =>
                createLink({
                  ...DEFAULT_LINK_PROPS,
                  domain,
                  key: "_root",
                  url: "",
                  tags: undefined,
                  userId,
                  projectId: workspace.id,
                }),
              ),
            ]);
          }

          addedDomains.push(...domainsNotInWorkspace);

          // Process all links
          const processedLinks = await Promise.all(
            linksToCreate.map(({ createdAt, tags, ...link }) =>
              processLink({
                payload: {
                  ...createLinkBodySchema.parse({
                    ...link,
                    tagNames: tags || undefined,
                  }),
                  // 'createdAt' is not a valid field in createLinkBodySchema – but is valid for CSV imports
                  createdAt: createdAt?.toISOString(),
                },
                workspace: workspace as WorkspaceProps,
                userId,
                bulk: true,
              }),
            ),
          );

          let validLinks = processedLinks
            .filter(({ error }) => error == null)
            .map(({ link }) => link) as ProcessedLinkProps[];

          let errorLinks = processedLinks
            .filter(({ error }) => error != null)
            .map(({ link: { domain, key }, error }) => ({
              domain,
              key,
              error,
            }));

          // Keep track of error links
          if (errorLinks.length > 0) {
            await redis.rpush(
              `import:csv:${workspaceId}:${id}:failed`,
              ...errorLinks,
            );
          }

          // Create all links
          await bulkCreateLinks({
            links: validLinks,
          });

          if (selectedDomains.length > 0) {
            await redis.sadd(
              `import:csv:${workspaceId}:${id}:domains`,
              ...selectedDomains,
            );
          }

          count += validLinks.length;

          cursor += data.length;
          await redis.set(`import:csv:${workspaceId}:${id}:cursor`, cursor);

          parser.resume();
        },
      });
    });

    const errorLinks = (await redis.lrange(
      `import:csv:${workspaceId}:${id}:failed`,
      0,
      -1,
    )) as any;

    const affectedDomains = (await redis.smembers(
      `import:csv:${workspaceId}:${id}:domains`,
    )) as any;

    await sendCsvImportEmails({
      workspaceId,
      count,
      domains:
        Array.isArray(affectedDomains) && affectedDomains.length > 0
          ? affectedDomains
          : [],
      errorLinks:
        Array.isArray(errorLinks) && errorLinks.length > 0 ? errorLinks : [],
    });

    // Clear out storage file and redis keys
    const clearResults = await Promise.allSettled([
      storage.delete(url),
      redis.del(`import:csv:${workspaceId}:${id}:cursor`),
      redis.del(`import:csv:${workspaceId}:${id}:failed`),
      redis.del(`import:csv:${workspaceId}:${id}:domains`),
    ]);
    clearResults.forEach((result, idx) => {
      if (result.status === "rejected") {
        console.error(`Error clearing CSV import data (${idx})`, result.reason);
      }
    });

    return NextResponse.json({
      response: "success",
    });
  } catch (error) {
    await log({
      message: `Error importing CSV links: ${error.message}`,
      type: "cron",
    });

    return handleAndReturnErrorResponse(error);
  }
}
