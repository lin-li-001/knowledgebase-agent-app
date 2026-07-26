export interface RoutingPolicy {
  decisionPath(decisionId: string): string;
  exportDir(): string;
  importAttachmentRoot(): string;
  importAttachmentDir(batchName: string): string;
  importSummaryDir(): string;
  importSummaryNotePath(batchName: string): string;
  profilePath(profileId: string): string;
  profileMemoryPath(profileId: string): string;
}

const importAttachmentRoot = "06-Attachments/Imports";
const importSummaryDir = "04-Resources/Imports";
const exportDir = ".app/exports";
const decisionDir = ".vault/decisions";

export const defaultRoutingPolicy: RoutingPolicy = {
  decisionPath(decisionId: string): string {
    return `${decisionDir}/${decisionId}.md`;
  },
  exportDir(): string {
    return exportDir;
  },
  importAttachmentRoot(): string {
    return importAttachmentRoot;
  },
  importAttachmentDir(batchName: string): string {
    return `${importAttachmentRoot}/${batchName}`;
  },
  importSummaryDir(): string {
    return importSummaryDir;
  },
  importSummaryNotePath(batchName: string): string {
    return `${importSummaryDir}/${batchName}.md`;
  },
  profilePath(profileId: string): string {
    return `02-Profiles/${profileId}/Profile.md`;
  },
  profileMemoryPath(profileId: string): string {
    return `02-Profiles/${profileId}/Memory.md`;
  },
};
