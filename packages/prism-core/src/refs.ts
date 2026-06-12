export interface ParsedNamedRef {
  readonly pluginPrefix: string | undefined;
  readonly name: string;
}

export interface ParsedSpaceItemRef {
  readonly pluginPrefix: string | undefined;
  readonly space: string;
  readonly name: string;
}

export interface RegistryWithDeps<TSelf> {
  readonly deps: ReadonlyMap<string, TSelf>;
}

export const parseNamedRef = (ref: string): ParsedNamedRef => {
  const colon = ref.indexOf(":");
  if (colon === -1) return { pluginPrefix: undefined, name: ref };
  return {
    pluginPrefix: ref.slice(0, colon),
    name: ref.slice(colon + 1),
  };
};

export const parseSpaceItemRef = (
  ref: string,
  separator: "/" | "#",
): ParsedSpaceItemRef | undefined => {
  const parsed = parseNamedRef(ref);
  const split = parsed.name.indexOf(separator);
  if (split === -1) return undefined;
  const space = parsed.name.slice(0, split);
  const name = parsed.name.slice(split + 1);
  if (space.length === 0 || name.length === 0) return undefined;
  return { pluginPrefix: parsed.pluginPrefix, space, name };
};

export const registryForRef = <TRegistry extends RegistryWithDeps<TRegistry>>(
  ref: string,
  registry: TRegistry,
): TRegistry | undefined => {
  const parsed = parseNamedRef(ref);
  if (!parsed.pluginPrefix) return registry;
  return registry.deps.get(parsed.pluginPrefix);
};
