import { generateRandomName } from "@/lib/names";
import useWorkspace from "@/lib/swr/use-workspace";
import { Customer } from "@/lib/types";
import { ChartActivity2 } from "@dub/ui";
import Link from "next/link";

export function CustomerRowItem({ customer }: { customer: Customer }) {
  const { slug } = useWorkspace();
  const display = customer.email || customer.name || generateRandomName();

  return (
    <Link
      href={`/${slug}/customers/${customer.id}`}
      target="_blank"
      className="group flex cursor-alias items-center justify-between gap-2 px-4 py-2.5 decoration-dotted hover:underline"
    >
      <div className="flex items-center gap-3 truncate" title={display}>
        <img
          alt={display}
          src={customer.avatar || ""}
          className="size-4 shrink-0 rounded-full border border-neutral-200"
        />
        <span className="truncate">{display}</span>
      </div>
      <ChartActivity2 className="size-3.5 shrink-0 transition-all group-hover:-translate-x-3 group-hover:opacity-0" />
    </Link>
  );
}
