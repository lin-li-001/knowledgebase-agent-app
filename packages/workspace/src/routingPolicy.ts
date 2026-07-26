export interface RoutingPolicy {
  importAttachmentRoot(): string;
  importAttachmentDir(batchName: string): string;
  importSummaryDir(): string;
  importSummaryNotePath(batchName: string): string;
  profileMemoryPath(profileId: string): string;
}

const importAttachmentRoot = "06-Attachments/Imports";
const importSummaryDir = "04-Resources/Imports";

export const defaultRoutingPolicy: RoutingPolicy = {
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
