export interface RoutingPolicy {
  decisionPath(decisionId: string): string;
  exportDir(): string;
  importAttachmentRoot(): string;
  importAttachmentDir(batchName: string): string;
  importInboxDir(): string;
  importInboxNotePath(batchName: string): string;
  importInboxSourceNotePath(batchName: string, sourceStem: string): string;
  importPromotionJournalDir(): string;
  importPromotionJournalPath(journalId: string): string;
  importStagingRoot(): string;
  importStagingDir(importId: string): string;
  importStagingNotePath(importId: string, sourceStem: string): string;
  importSourceNotePath(batchName: string, sourceStem: string): string;
  importSummaryDir(): string;
  importSummaryNotePath(batchName: string): string;
  profileFinanceDir(profileId: string): string;
  profilePath(profileId: string): string;
  profileMemoryPath(profileId: string): string;
}

const importAttachmentRoot = "06-Attachments/Imports";
const importInboxDir = "00-Inbox/Imports";
const importSummaryDir = "04-Resources/Imports";
const importStagingRoot = ".app/import-staging";
const importPromotionJournalRoot = ".app/import-promotion-journal";
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
  importInboxDir(): string {
    return importInboxDir;
  },
  importInboxNotePath(batchName: string): string {
    return `${importInboxDir}/${batchName}.md`;
  },
  importInboxSourceNotePath(batchName: string, sourceStem: string): string {
    return `${importInboxDir}/${batchName}/${sourceStem}.md`;
  },
  importPromotionJournalDir(): string {
    return importPromotionJournalRoot;
  },
  importPromotionJournalPath(journalId: string): string {
    return `${importPromotionJournalRoot}/${journalId}.json`;
  },
  importStagingRoot(): string {
    return importStagingRoot;
  },
  importStagingDir(importId: string): string {
    return `${importStagingRoot}/${importId}`;
  },
  importStagingNotePath(importId: string, sourceStem: string): string {
    return `${importStagingRoot}/${importId}/${sourceStem}.md`;
  },
  importSourceNotePath(batchName: string, sourceStem: string): string {
    return `${importSummaryDir}/${batchName}/${sourceStem}.md`;
  },
  importSummaryDir(): string {
    return importSummaryDir;
  },
  importSummaryNotePath(batchName: string): string {
    return `${importSummaryDir}/${batchName}.md`;
  },
  profileFinanceDir(profileId: string): string {
    return `02-Personal/${profileId}/Finance`;
  },
  profilePath(profileId: string): string {
    return `02-Profiles/${profileId}/Profile.md`;
  },
  profileMemoryPath(profileId: string): string {
    return `02-Profiles/${profileId}/Memory.md`;
  },
};
