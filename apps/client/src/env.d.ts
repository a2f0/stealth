/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

interface PlaidLinkMetadata {
  institution: {
    institution_id: string | null;
    name: string | null;
  } | null;
}

interface PlaidLinkError {
  error_message?: string | null;
}

interface PlaidLinkHandler {
  destroy: () => void;
  open: () => void;
}

interface Window {
  Plaid?: {
    create: (configuration: {
      onExit: (error: PlaidLinkError | null) => void;
      onSuccess: (publicToken: string, metadata: PlaidLinkMetadata) => void;
      receivedRedirectUri?: string;
      token: string;
    }) => PlaidLinkHandler;
  };
}
