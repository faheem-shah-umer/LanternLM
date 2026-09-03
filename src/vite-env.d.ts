/// <reference types="vite/client" />

declare global {
  interface Window {
    api: any;
    app: {
      quit: () => Promise<boolean>;
    };
    files: {
      list: (path?: string) => Promise<{ name: string; isDir: boolean; path: string; size: number }[]>;
      readText: (path: string) => Promise<string>;
      copyToExports: (path: string) => Promise<string>;
      url: (path: string) => string;
      openInExplorer: (path: string) => Promise<boolean>;
      rename: (path: string, name: string) => Promise<boolean>;
      delete: (path: string) => Promise<boolean>;
      importToDir: (dir: string, sourcePaths: string[]) => Promise<string[]>;
    };
  }
}

export {};
