export type SceneElement = Record<string, unknown> & {
  id: string;
  type: string;
  isDeleted?: boolean;
};

type Binding = { elementId: string } | null | undefined;

/**
 * Canonical in-memory copy of the canvas scene. The browser client is the
 * source of truth for mutations; this store mirrors it so MCP reads work
 * without a round-trip and late-joining tabs can catch up.
 */
export class SceneStore {
  private elements: SceneElement[] = [];

  replace(elements: SceneElement[]) {
    this.elements = elements;
  }

  all(): SceneElement[] {
    return this.elements;
  }

  /**
   * Token-lean projection for the agent: geometry, style and relationships
   * only. Full element payloads are an order of magnitude larger.
   */
  compact(): Record<string, unknown>[] {
    return this.elements
      .filter((element) => !element.isDeleted)
      .map((element) => {
        const compact: Record<string, unknown> = {
          id: element.id,
          type: element.type,
          x: Math.round(element.x as number),
          y: Math.round(element.y as number),
          width: Math.round(element.width as number),
          height: Math.round(element.height as number)
        };
        if (element.angle) {
          compact.angle = element.angle;
        }
        for (const key of ["text", "fontSize", "strokeColor", "backgroundColor", "containerId", "frameId"]) {
          if (element[key] != null && element[key] !== "") {
            compact[key] = element[key];
          }
        }
        if (Array.isArray(element.groupIds) && element.groupIds.length > 0) {
          compact.groupIds = element.groupIds;
        }
        const startBinding = element.startBinding as Binding;
        const endBinding = element.endBinding as Binding;
        if (startBinding?.elementId) {
          compact.startBoundTo = startBinding.elementId;
        }
        if (endBinding?.elementId) {
          compact.endBoundTo = endBinding.elementId;
        }
        return compact;
      });
  }
}
