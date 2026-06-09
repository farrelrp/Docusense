const API_BASE_URL = "http://localhost:8000";
const MAX_PREVIEW_HTML_CHARS = 200_000;

export type JobState =
  | "idle"
  | "uploading"
  | "checking"
  | "warning"
  | "processing"
  | "completed"
  | "error";

export interface ProcessingResult {
  jobId: string;
  pageCount: number;
  resultUrl: string;
  previewHtml: string;
  cached: boolean;
}

export interface WarningResult {
  status: "warning";
  warning_type: "PAGE_LIMIT_EXCEEDED";
  message: string;
  page_count: number;
  can_continue: boolean;
}

export interface CacheMissResult {
  status: "not_found";
}

interface CompletedApiResponse {
  job_id: string;
  status: "completed";
  page_count: number;
  result_url: string;
  preview_html: string;
  cached?: boolean;
}

interface ErrorApiResponse {
  status: "error";
  error_code: string;
  message: string;
}

export type JobApiResult = ProcessingResult | WarningResult;
export type CacheApiResult = ProcessingResult | CacheMissResult;

export async function processPdfUpload(file: File, force = false): Promise<JobApiResult> {
  const formData = new FormData();
  formData.append("file", file);
  formData.append("force", String(force));

  const response = await fetch(`${API_BASE_URL}/api/jobs/upload`, {
    method: "POST",
    body: formData,
  });

  return parseJobResponse(response);
}

export async function processPdfUrl(url: string, force = false): Promise<JobApiResult> {
  const response = await fetch(`${API_BASE_URL}/api/jobs/url`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ url, force }),
  });

  return parseJobResponse(response);
}

export async function checkPdfUploadCache(file: File): Promise<CacheApiResult> {
  const formData = new FormData();
  formData.append("file", file);
  const response = await fetch(`${API_BASE_URL}/api/jobs/cache/upload`, {
    method: "POST",
    body: formData,
  });
  return parseCacheResponse(response);
}

export async function checkPdfUrlCache(url: string): Promise<CacheApiResult> {
  const response = await fetch(`${API_BASE_URL}/api/jobs/cache/url`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ url }),
  });
  return parseCacheResponse(response);
}

async function parseJobResponse(response: Response): Promise<JobApiResult> {
  const data = (await response.json()) as CompletedApiResponse | WarningResult | ErrorApiResponse;

  if (!response.ok || data.status === "error") {
    const message =
      "message" in data ? data.message : "DocuSense could not complete this request.";
    throw new Error(message);
  }

  if (data.status === "warning") {
    return data;
  }

  return {
    jobId: data.job_id,
    pageCount: data.page_count,
    resultUrl: data.result_url,
    previewHtml: compactPreviewHtml(data.preview_html),
    cached: Boolean(data.cached),
  };
}

async function parseCacheResponse(response: Response): Promise<CacheApiResult> {
  const data = (await response.json()) as CompletedApiResponse | CacheMissResult | ErrorApiResponse;
  if (!response.ok || data.status === "error") {
    const message =
      "message" in data ? data.message : "DocuSense could not check this PDF.";
    throw new Error(message);
  }
  if (data.status === "not_found") {
    return data;
  }
  return {
    jobId: data.job_id,
    pageCount: data.page_count,
    resultUrl: data.result_url,
    previewHtml: compactPreviewHtml(data.preview_html),
    cached: true,
  };
}

function compactPreviewHtml(html: string): string {
  if (html.length <= MAX_PREVIEW_HTML_CHARS) {
    return html;
  }

  return `${html.slice(0, MAX_PREVIEW_HTML_CHARS)}
<p>Open the full HTML result to read the complete processed document.</p>`;
}
