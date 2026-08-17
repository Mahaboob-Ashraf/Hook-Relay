import type { RelatedDelivery } from "../api/client";
import { shortId } from "../utilities/format";
import { StatusLabel } from "./StatusLabel";
import { Timestamp } from "./Timestamp";

type ReplayNode = RelatedDelivery & { children: ReplayNode[] };

export function buildReplayForest(deliveries: RelatedDelivery[]): ReplayNode[] {
  const byId = new Map<string, ReplayNode>();
  for (const delivery of deliveries) byId.set(delivery.id, { ...delivery, children: [] });

  const roots: ReplayNode[] = [];
  for (const node of byId.values()) {
    const parent = node.replayedFromDeliveryId
      ? byId.get(node.replayedFromDeliveryId)
      : undefined;
    if (parent && parent.id !== node.id) parent.children.push(node);
    else roots.push(node);
  }

  const sortNodes = (nodes: ReplayNode[], path = new Set<string>()) => {
    nodes.sort((left, right) =>
      left.createdAt === right.createdAt
        ? left.id.localeCompare(right.id)
        : left.createdAt.localeCompare(right.createdAt),
    );
    for (const node of nodes) {
      if (path.has(node.id)) {
        node.children = [];
        continue;
      }
      sortNodes(node.children, new Set([...path, node.id]));
    }
  };
  sortNodes(roots);

  const reachable = new Set<string>();
  const visit = (node: ReplayNode) => {
    if (reachable.has(node.id)) return;
    reachable.add(node.id);
    node.children.forEach(visit);
  };
  roots.forEach(visit);
  for (const node of byId.values()) {
    if (!reachable.has(node.id)) {
      node.children = [];
      roots.push(node);
    }
  }
  return roots;
}

function ReplayBranch({
  nodes,
  selectedId,
  onSelect,
  depth = 0,
}: {
  nodes: ReplayNode[];
  selectedId: string;
  onSelect: (deliveryId: string) => void;
  depth?: number;
}) {
  return (
    <ul className={depth === 0 ? "replay-tree" : "replay-children"}>
      {nodes.map((node) => {
        const selected = node.id === selectedId;
        return (
          <li key={node.id}>
            <span className="replay-node" aria-hidden="true" />
            <button
              type="button"
              className={selected ? "replay-entry is-selected" : "replay-entry"}
              onClick={() => onSelect(node.id)}
              aria-current={selected ? "true" : undefined}
              aria-label={`${selected ? "Selected" : "Inspect"} ${node.replayedFromDeliveryId ? "replay" : "original"} delivery ${node.id}, status ${node.status.replace("_", " ")}, created ${node.createdAt}`}
            >
              <span>
                <strong>{node.replayedFromDeliveryId ? "Replay" : "Original"}</strong>
                <span className="mono" title={node.id}>{shortId(node.id)}</span>
              </span>
              <span className="replay-entry-meta">
                <StatusLabel status={node.status} />
                <Timestamp value={node.createdAt} />
              </span>
            </button>
            {node.children.length > 0 ? (
              <ReplayBranch nodes={node.children} selectedId={selectedId} onSelect={onSelect} depth={depth + 1} />
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

export function ReplayHistory({
  deliveries,
  selectedId,
  onSelect,
}: {
  deliveries: RelatedDelivery[];
  selectedId: string;
  onSelect: (deliveryId: string) => void;
}) {
  return (
    <section className="detail-section replay-section" aria-labelledby="replay-history-heading">
      <div className="section-heading-row">
        <div>
          <p className="section-kicker">Recovery lineage</p>
          <h3 id="replay-history-heading">Replay history</h3>
        </div>
        <span className="section-count">{deliveries.length} related</span>
      </div>
      <p className="section-intro">Each branch preserves the immediate delivery that was replayed.</p>
      <ReplayBranch nodes={buildReplayForest(deliveries)} selectedId={selectedId} onSelect={onSelect} />
    </section>
  );
}
