/**
 * Component registry — SPEC §2.1/§7.
 *
 * Registration order IS the canonical iteration order used by the digest
 * recipe (and later save serialization), so it is pinned to strict
 * alphabetical component-name order. Out-of-order or duplicate
 * registration throws loudly instead of silently reordering.
 */
export class ComponentRegistry {
  readonly #idsByName = new Map<string, number>();
  readonly #namesById: string[] = [];

  register(name: string): number {
    if (name.length === 0) {
      throw new Error("component name must be non-empty");
    }
    if (this.#idsByName.has(name)) {
      throw new Error(`component already registered: ${JSON.stringify(name)}`);
    }
    const previous = this.#namesById[this.#namesById.length - 1];
    if (previous !== undefined && !(previous < name)) {
      throw new Error(
        `components must be registered in ascending alphabetical order: ${JSON.stringify(name)} cannot follow ${JSON.stringify(previous)}`,
      );
    }
    const id = this.#namesById.length;
    this.#namesById.push(name);
    this.#idsByName.set(name, id);
    return id;
  }

  /** Id for a registered component; throws when unknown. */
  idOf(name: string): number {
    const id = this.#idsByName.get(name);
    if (id === undefined) {
      throw new Error(`unknown component: ${JSON.stringify(name)}`);
    }
    return id;
  }

  /** Name for a registered component id; throws when out of range. */
  nameOf(id: number): string {
    const name = this.#namesById[id];
    if (name === undefined) {
      throw new Error(`unknown component id: ${String(id)}`);
    }
    return name;
  }

  get size(): number {
    return this.#namesById.length;
  }

  /** Component names in registration (= digest iteration) order. */
  namesInOrder(): readonly string[] {
    return [...this.#namesById];
  }
}
