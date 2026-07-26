export interface RoutingPolicy {
  exportDir(): string;
  importAttachmentRoot(): string;
  importAttachmentDir(batchName: string): string;
  importSummaryDir(): string;
  importSummaryNotePath(batchName: string): string;
  profileMemoryPath(profileId: string): string;
}

const importAttachmentRoot = "06-Attachments/Imports";
const importSummaryDir = "04-Resources/Imports";
const exportDir = ".app/exports";

export const defaultRoutingPolicy: RoutingPolicy = {
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
  profileMemoryPath(profileId: string): string {
    return `02-Profiles/${profileId}/Memory.md`;
  },
};
