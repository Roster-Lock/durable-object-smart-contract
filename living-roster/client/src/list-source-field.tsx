import { useEffect, useMemo, useState } from "react";
import type { FieldProps } from "@rjsf/utils";
import type { Piece, UserSummary } from "@roster-lock/smart-contract-sdk";
import { useClientHost } from "@roster-lock/smart-contract-sdk/react";
import { filterListOptions, parseListSource, type ListOption } from "./model.js";
import { resolveSourceValues } from "./source.js";

/**
 * A select/search field whose values come from declared fetchable sources.
 *
 * piece/user: with no include, the host catalog search supplies every item;
 * includes union fetched values; excludes are subtracted last. labeled-value:
 * at least one include; each returned item must be `{ value, label }`.
 *
 * Source endpoints must be public/human and `mutates: false`. They are fetched
 * without a confirmation prompt because they are list reads, not form calls;
 * the host should cache/authorize them accordingly.
 */
export function ListSourceField(props: FieldProps) {
  const host = useClientHost();
  const schema = props.schema as Record<string, unknown> | undefined;
  const rawSource = schema?.["x-roster-list"] ?? schema?.["x-roster-source"];
  const sourceKey = JSON.stringify(rawSource ?? null);
  const source = useMemo(() => parseListSource(rawSource), [sourceKey]);
  const value = typeof props.value === "string" ? props.value : "";
  const requireLabel = source?.kind === "labeled-value";
  const catalogMode =
    source !== undefined &&
    (source.kind === "piece" || source.kind === "user") &&
    (!source.include || source.include.length === 0);
  const invalidSource = rawSource !== undefined && source === undefined;

  const [options, setOptions] = useState<ListOption[]>([]);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [selectedLabel, setSelectedLabel] = useState<string | undefined>();

  useEffect(() => {
    if (!source) {
      setOptions([]);
      setLoading(false);
      setError(undefined);
      return;
    }
    if (catalogMode) return;

    let live = true;
    setLoading(true);
    setError(undefined);
    void (async () => {
      try {
        const includes =
          source.kind === "labeled-value" || (source.include && source.include.length > 0)
            ? await resolveSourceValues(host, source.include ?? [], "options", requireLabel)
            : { options: [], values: new Set<string>() };
        const excludes = await resolveSourceValues(host, source.exclude ?? [], "values", false);
        if (!live) return;
        setOptions(
          filterListOptions(includes.options, {
            ...(source.include ? { include: includes.values } : {}),
            exclude: excludes.values,
          }),
        );
      } catch (cause) {
        if (live) setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        if (live) setLoading(false);
      }
    })();
    return () => {
      live = false;
    };
  }, [sourceKey, catalogMode, host, requireLabel]);

  useEffect(() => {
    if (!source || !catalogMode) return;
    let live = true;
    setLoading(true);
    setError(undefined);
    void (async () => {
      try {
        const excludes = await resolveSourceValues(host, source.exclude ?? [], "values", false);
        const items =
          source.kind === "piece"
            ? await host.catalog.searchPieces(query.trim(), query.trim() ? 20 : 50)
            : await host.catalog.searchUsers(query.trim(), query.trim() ? 20 : 50);
        if (!live) return;
        setOptions(
          filterListOptions(items.map((item) => toCatalogOption(item)), {
            exclude: excludes.values,
          }),
        );
      } catch (cause) {
        if (live) setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        if (live) setLoading(false);
      }
    })();
    return () => {
      live = false;
    };
  }, [sourceKey, catalogMode, query, host]);

  useEffect(() => {
    if (!value || (source?.kind !== "piece" && source?.kind !== "user")) {
      setSelectedLabel(undefined);
      return;
    }
    let live = true;
    const request =
      source.kind === "piece"
        ? host.catalog.getPiece(value).then((piece) => piece?.title)
        : host.catalog.getUser(value).then((user) => user?.displayName);
    request.then((label) => {
      if (live) setSelectedLabel(label);
    });
    return () => {
      live = false;
    };
  }, [value, source?.kind, host]);

  const selected = options.find((option) => option.value === value);
  const selectedText = selectedLabel ?? selected?.label ?? value;
  const needle = query.trim().toLowerCase();
  const visible = options
    .filter(
      (option) =>
        !needle ||
        option.label.toLowerCase().includes(needle) ||
        option.value.toLowerCase().includes(needle),
    )
    .slice(0, 50);

  return (
    <div id={props.id} className="rl-schema-list-source">
      {value ? (
        <p>
          Selected: {selectedText}{" "}
          <button type="button" disabled={props.disabled} onClick={() => props.onChange("")}>
            Clear
          </button>
        </p>
      ) : null}
      <input
        aria-label={props.label ?? "Search options"}
        placeholder={
          invalidSource
            ? "Invalid list source configuration"
            : source
              ? "Search options"
              : "No list source configured"
        }
        value={query}
        disabled={!source || props.disabled}
        onChange={(event) => setQuery(event.target.value)}
      />
      {invalidSource ? <p role="alert">Invalid x-roster-list configuration.</p> : null}
      {loading ? <p>Loading options…</p> : null}
      {error ? <p role="alert">{error}</p> : null}
      {!loading && !error && visible.length === 0 ? <p>No matching options.</p> : null}
      {visible.length > 0 ? (
        <ul>
          {visible.map((option) => (
            <li key={option.value}>
              <button
                type="button"
                disabled={props.disabled}
                onClick={() => {
                  props.onChange(option.value);
                  setQuery("");
                }}
              >
                {option.label}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {props.rawErrors?.map((message) => (
        <p key={message} role="alert">
          {message}
        </p>
      ))}
    </div>
  );
}

function toCatalogOption(item: Piece | UserSummary): ListOption {
  return "title" in item
    ? { value: item.id, label: item.title }
    : { value: item.id, label: item.displayName };
}
