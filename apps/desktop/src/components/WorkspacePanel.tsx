import { useMemo, useState } from "react";
import { ActivityFeed, type ActivityItem } from "./ActivityFeed";

export interface WorkspaceTreeNode {
  name: string;
  path: string;
  type: "directory" | "file";
  children?: WorkspaceTreeNode[];
}

export interface WorkspaceFilePreview {
  path: string;
  content: string;
  previewType: "text" | "unsupported";
}

export function WorkspacePanel({
  activityItems,
  tree,
  preview,
  hasWorkspace,
  onReadFile,
}: {
  activityItems: ActivityItem[];
  tree: WorkspaceTreeNode | null;
  preview: WorkspaceFilePreview | null;
  hasWorkspace: boolean;
  onReadFile(path: string): Promise<void>;
}) {
  const [activeTab, setActiveTab] = useState<"activity" | "files">("activity");
  const [filter, setFilter] = useState("");
  const filteredTree = useMemo(() => filterTree(tree, filter.trim().toLowerCase()), [tree, filter]);

  return (
    <aside className="activity-panel workspace-panel" aria-label="Activity">
      <div className="panel-header">
        <h2>{activeTab === "activity" ? "Activity" : "Files"}</h2>
      </div>
      <div className="panel-tabs" role="tablist" aria-label="Workspace panel">
        <button type="button" className={activeTab === "activity" ? "panel-tab active" : "panel-tab"} onClick={() => setActiveTab("activity")}>
          Activity
        </button>
        <button type="button" className={activeTab === "files" ? "panel-tab active" : "panel-tab"} onClick={() => setActiveTab("files")}>
          Files
        </button>
      </div>
      {activeTab === "activity" ? (
        <ActivityFeed items={activityItems} compact />
      ) : (
        <div className="file-explorer">
          {!hasWorkspace ? <p className="empty-state">Open a workspace to browse files.</p> : null}
          {hasWorkspace ? (
            <>
              <input
                aria-label="Filter files"
                placeholder="Filter files..."
                value={filter}
                onChange={(event) => setFilter(event.target.value)}
              />
              {filteredTree ? (
                <div className="file-tree" role="tree">
                  <TreeNode node={filteredTree} depth={0} onReadFile={onReadFile} />
                </div>
              ) : (
                <p className="empty-state">No matching files</p>
              )}
              {preview ? (
                <section className="file-preview" aria-label="File preview">
                  <strong>{preview.path}</strong>
                  <pre>{preview.content}</pre>
                </section>
              ) : null}
            </>
          ) : null}
        </div>
      )}
    </aside>
  );
}

function TreeNode({ node, depth, onReadFile }: { node: WorkspaceTreeNode; depth: number; onReadFile(path: string): Promise<void> }) {
  const [isOpen, setIsOpen] = useState(true);

  if (node.type === "file") {
    return (
      <button
        type="button"
        className="file-node"
        style={{ paddingLeft: `${depth * 14 + 8}px` }}
        onClick={() => void onReadFile(node.path)}
      >
        {node.name}
      </button>
    );
  }

  return (
    <div className="directory-node">
      {node.path ? (
        <button
          type="button"
          className={isOpen ? "directory-label open" : "directory-label"}
          style={{ paddingLeft: `${depth * 14 + 8}px` }}
          aria-expanded={isOpen}
          onClick={() => setIsOpen((current) => !current)}
        >
          {node.name}
        </button>
      ) : null}
      {isOpen
        ? node.children?.map((child) => (
            <TreeNode key={child.path || child.name} node={child} depth={node.path ? depth + 1 : depth} onReadFile={onReadFile} />
          ))
        : null}
    </div>
  );
}

function filterTree(node: WorkspaceTreeNode | null, filter: string): WorkspaceTreeNode | null {
  if (!node) {
    return null;
  }
  if (!filter) {
    return node;
  }

  const children = node.children?.map((child) => filterTree(child, filter)).filter((child): child is WorkspaceTreeNode => Boolean(child)) ?? [];
  if (node.name.toLowerCase().includes(filter) || node.path.toLowerCase().includes(filter) || children.length) {
    return { ...node, children };
  }
  return null;
}
