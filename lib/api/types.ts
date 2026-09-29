export type TranslationMode = 'quick' | 'reference_style' | 'local_style' | 'learning_style';
export type ExportFormat = 'rendered' | 'psd' | 'khr' | 'inpainted';

export interface TranslationTarget {
  providerId: string;
  modelId: string;
}

export interface TranslationProviderModel extends TranslationTarget {
  name: string;
  languages: string[];
  targetKind: 'local' | 'provider' | string;
}

export interface TranslationProvider {
  providerId: string;
  name: string;
  kind: 'local_llm' | 'hosted_llm' | 'machine_translation' | string;
  status: string;
  hasCredential: boolean | null;
  requiresCredential?: boolean;
  models: TranslationProviderModel[];
  error?: string | null;
}

export interface TranslationProviderCatalog {
  baseUrl?: string;
  providers: TranslationProvider[];
  defaultTarget: TranslationTarget | null;
}

export interface HealthResponse {
  ok: boolean;
}

export interface RuntimeServiceStatus {
  status: string;
  baseUrl?: string | null;
  lastError?: string | null;
  [key: string]: unknown;
}

export interface RuntimeStatus {
  backend: RuntimeServiceStatus;
  koharu: RuntimeServiceStatus;
  agent: RuntimeServiceStatus;
  quality?: Record<string, unknown>;
  translation?: Record<string, unknown>;
}

export interface UploadFileRecord {
  fileName: string;
  size: number;
  uploadedAt: string;
}

export interface UploadSession {
  uploadId: string;
  kind: 'source' | 'reference';
  status: 'uploading' | 'ready';
  files: UploadFileRecord[];
  createdAt: string;
  updatedAt: string;
}

export interface SourceImage {
  id: string;
  fileName: string;
  actualFormat: string;
  converted: boolean;
  convertedFrom?: string | null;
  orderedName: string;
  orderIndex: number;
}

export interface RejectedFile {
  fileName: string;
  reason: string;
}

export interface SourcePreflight {
  preflightId: string;
  createdAt: string;
  updatedAt: string;
  ready: boolean;
  orderChanged: boolean;
  summary: {
    discoveredCount: number;
    acceptedCount: number;
    convertedCount: number;
    rejectedCount: number;
  };
  rejectedFiles: RejectedFile[];
  images: SourceImage[];
}

export interface TranslationJobRequest {
  translationMode: TranslationMode;
  translationTarget?: TranslationTarget;
  targetLanguage: string;
  qualityCheck: boolean;
  exportFormat: ExportFormat;
  mangaId: string;
  translatorId: string;
  chapterId: string;
  sourcePreflightId: string;
  sourceLanguage?: string;
  referenceTranslatorId?: string;
}

export type JobStatus =
  | 'queued'
  | 'waiting_dependency'
  | 'waiting_prerequisite'
  | 'waiting_koharu_review'
  | 'running'
  | 'cancel_requested'
  | 'succeeded'
  | 'failed'
  | 'canceled'
  | 'blocked'
  | string;

export interface JobResource {
  id: string;
  type: string;
  status: JobStatus;
  stage: string;
  payload?: Record<string, unknown>;
  result: Record<string, unknown> | null;
  error: string | null;
  retryOf?: string | null;
  createdAt: string;
  updatedAt: string;
  executionKind?: string;
  workflowId?: string | null;
  parentJobId?: string | null;
  dependencyIds?: string[];
  blockedReason?: string | null;
  outcome?: 'clean' | 'warnings' | 'partial' | string | null;
  diagnostics?: Record<string, unknown> | null;
  resumeMetadata?: {
    resumeAvailable?: boolean;
    checkpointPaths?: string[];
    failedWindowId?: string | null;
    resourceFailureType?: string | null;
    [key: string]: unknown;
  } | null;
  childJobIds?: string[];
  children?: JobResource[];
  events?: JobEvent[];
  artifacts?: JobArtifact[];
}

export interface JobEvent {
  id?: number;
  type: string;
  payload?: Record<string, unknown> | null;
  createdAt: string;
  job?: Partial<JobResource>;
}

export interface JobArtifact {
  id: number;
  jobId?: string;
  kind: string;
  createdAt?: string;
  metadata?: Record<string, unknown> | null;
}

export interface EventsEnvelope {
  events: JobEvent[];
}

export interface ArtifactsEnvelope {
  artifacts: JobArtifact[];
}

export interface TranslatedImage {
  id: string;
  index: number;
  fileName: string;
  mediaType: string;
  size: number;
  encodedUrl: string;
  contentUrl: string;
}

export interface TranslatedImagesEnvelope {
  jobId: string;
  artifactId: number;
  sourceFormat: 'image' | 'zip';
  count: number;
  images: TranslatedImage[];
}

export interface UploadProgress {
  fileIndex: number;
  fileCount: number;
  fileName: string;
  fileLoaded: number;
  fileTotal: number;
  totalLoaded: number;
  totalBytes: number;
  percent: number;
}

export interface ApiSettings {
  baseUrl: string;
  token: string;
  comicCrawler: ComicCrawlerSettings;
}

export interface ComicCrawlerSettings {
  enabled: boolean;
  autoApplyPreviousTranslation: boolean;
  baseUrl: string;
  username: string;
  password: string;
}
