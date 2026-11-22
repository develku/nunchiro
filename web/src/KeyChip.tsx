// A key as a chip: the user's own prefix symbol where UI text would say "prefix", spelled out for a screen reader.
import { label, PREFIX_SYMBOL, spelled, spoken, type Binding, type Bindings } from "./keys";
import { useHtmlLangT } from "./i18n/lib/useHtmlLangT";

export function KeyChip({
  binding,
  bindings,
}: {
  binding: Binding;
  bindings?: Bindings;
}) {
  return (
    // A key after the prefix shows the prefix as its symbol; the tip spells the real keys.
    <span className="kbd" role="img" aria-label={spoken(binding, bindings)} data-tip={binding.startsWith("prefix ") ? spelled(binding, bindings) : undefined}>
      {label(binding, bindings)}
    </span>
  );
}

/** The prefix alone, as its symbol (the tip and the spoken name are its real keys): before a key that follows it. */
export function PrefixChip({ bindings }: { bindings: Bindings }) {
  const t = useHtmlLangT();
  const first = bindings.prefix?.[0] ?? "";
  return first ? (
    <span className="kbd" role="img" aria-label={spoken(first, bindings)} data-tip={label(first, bindings)}>
      {PREFIX_SYMBOL}
    </span>
  ) : (
    <span className="kbd">{t("settings.keys.prefixWord")}</span>
  );
}
