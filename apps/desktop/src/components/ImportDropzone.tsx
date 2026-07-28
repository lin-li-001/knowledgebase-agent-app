import { useState } from "react";

interface ImportDropzoneProps {
  disabled: boolean;
  onImport(input: { batchName: string; filePaths: string[] }): Promise<void>;
}

export function ImportDropzone({ disabled, onImport }: ImportDropzoneProps) {
  const [batchName, setBatchName] = useState("");
  const [filePaths, setFilePaths] = useState<string[]>([]);
  const canImport = !disabled && batchName.trim().length > 0 && filePaths.length > 0;

  return (
    <div className="import-panel">
      <label>
        Batch name
        <input
          value={batchName}
          onChange={(event) => setBatchName(event.target.value)}
          placeholder="2026 Utility Bills"
          disabled={disabled}
        />
      </label>
      <label>
        Import files
        <input
          type="file"
          multiple
          accept=".pdf,.md,.markdown,.txt"
          disabled={disabled}
          onChange={(event) => {
            const files = Array.from(event.currentTarget.files ?? []);
            setFilePaths(files.map((file) => (file as File & { path?: string }).path ?? file.name));
          }}
        />
      </label>
      {filePaths.length ? <p className="inline-note">{filePaths.length} files selected</p> : null}
      <button type="button" disabled={!canImport} onClick={() => void onImport({ batchName: batchName.trim(), filePaths })}>
        Import Documents
      </button>
    </div>
  );
}
