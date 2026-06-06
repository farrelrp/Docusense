# DocuSense Option A Prototype Spec

## 1. Product Summary

DocuSense is a Microsoft Edge extension that helps visually impaired students read inaccessible research paper PDFs. The prototype will let users process either an online PDF opened in Edge or a local PDF uploaded through the extension. The backend will send the PDF directly to Gemini 2.5 Flash, then return a screen reader friendly HTML version of the paper.

This prototype intentionally avoids Azure implementation for now because no Azure credits are available. The code should still be structured so the Gemini processor can later be replaced by an Azure based processor using Azure AI Document Intelligence, Azure AI Vision, and Azure OpenAI.

The original DocuSense concept focuses on transforming inaccessible PDFs into screen reader ready documents by fixing reading order, explaining visual content, and producing a guided reading script. This prototype keeps the same user value but implements it with a simpler Gemini based architecture.

## 2. Goals

1. Build a hackathon ready prototype quickly.
2. Support both local PDF upload and online PDF URL processing.
3. Preserve the original document language, including English and Indonesian.
4. Convert research papers into semantic accessible HTML.
5. Mirror the paper section by section.
6. Include an introductory document summary containing title, authors, publisher or venue when available, and source language.
7. Warn users when a PDF is longer than 50 pages but still allow them to continue.
8. Keep the backend provider independent so Gemini can later be replaced with Azure services.
9. Do not require user sign in.
10. Use DocuSense blue and white branding in the extension UI.

## 3. Non Goals

1. Do not build a full production accessibility engine.
2. Do not generate tagged PDFs.
3. Do not generate audio files.
4. Do not build user accounts or institution admin dashboards.
5. Do not build permanent cloud storage.
6. Do not guarantee perfect figure interpretation.
7. Do not implement Azure yet.
8. Do not support every possible PDF type. The first target is research papers.

## 4. Target User Flow

### 4.1 Online PDF Flow

1. User opens a research paper PDF in Microsoft Edge.
2. User opens the DocuSense extension side panel.
3. Extension detects the current tab URL.
4. User clicks Process Current PDF.
5. Extension sends the URL to the FastAPI backend.
6. Backend downloads the PDF.
7. Backend checks page count.
8. If page count is above 50, backend returns a warning state.
9. User confirms continue.
10. Backend uploads the PDF to Gemini through the Gemini file input flow.
11. Gemini returns accessible semantic HTML.
12. Backend saves the result temporarily.
13. Extension displays the result in the side panel and also provides an Open Full Page button.
14. User opens the full result page in Edge.
15. User uses Edge Read Aloud or a screen reader on the generated HTML page.

### 4.2 Local PDF Flow

1. User opens the DocuSense extension side panel.
2. User clicks Upload PDF.
3. User selects a local PDF file.
4. Extension uploads the file to FastAPI.
5. Backend checks page count.
6. If page count is above 50, backend returns a warning state.
7. User confirms continue.
8. Backend sends the PDF to Gemini.
9. Gemini returns accessible semantic HTML.
10. Backend saves the result temporarily.
11. Extension displays the result and provides an Open Full Page button.

## 5. Preferred Output Format

The final output must be full semantic HTML because it works well with browser based reading tools and screen readers. The extension should show a preview, but the primary reading experience should be a full page HTML result because Edge Read Aloud and external screen readers work better on a full document page than inside a small extension panel.

The generated HTML must use semantic elements only where possible:

```html
<main>
  <article>
    <header>
      <h1>Document Title</h1>
      <p>Authors: ...</p>
      <p>Publisher or venue: ...</p>
      <p>Language: ...</p>
    </header>

    <nav aria-label="Document sections">
      <h2>Document navigation</h2>
      <ul>
        <li><a href="#abstract">Abstract</a></li>
        <li><a href="#introduction">Introduction</a></li>
      </ul>
    </nav>

    <section id="abstract">
      <h2>Abstract</h2>
      <p>...</p>
    </section>
  </article>
</main>
```

The result page must set the document language:

```html
<html lang="en">
```

or:

```html
<html lang="id">
```

If the language is uncertain, use:

```html
<html lang="en">
```

and show the detected language as uncertain in the intro metadata.

## 6. System Architecture

### 6.1 High Level Architecture

```text
React Edge Extension
    ↓
FastAPI Backend
    ↓
Temporary Local Storage
    ↓
Gemini 2.5 Flash
    ↓
Accessible HTML Result
    ↓
Extension Preview and Full Result Page
```

### 6.2 Repository Structure

```text
docusense/
  spec.md
  README.md
  backend/
    app/
      main.py
      config.py
      models.py
      services/
        pdf_service.py
        gemini_processor.py
        result_store.py
        html_sanitizer.py
      prompts/
        accessible_html_prompt.txt
      routes/
        jobs.py
        results.py
    requirements.txt
    .env.example
  extension/
    package.json
    vite.config.ts
    tsconfig.json
    public/
      manifest.json
      icons/
    src/
      App.tsx
      main.tsx
      api.ts
      components/
        Header.tsx
        PdfInputPanel.tsx
        ProgressView.tsx
        ResultPreview.tsx
        WarningModal.tsx
      styles.css
```

## 7. Backend Specification

### 7.1 Backend Technology

Use FastAPI with Python.

Required libraries:

```text
fastapi
uvicorn
python-multipart
pydantic
pydantic-settings
httpx
pypdf
google-genai
beautifulsoup4
bleach
python-dotenv
```

Optional later libraries:

```text
pymupdf
```

Use `pypdf` only for page count in Option A. Use PyMuPDF later if custom page rendering, cropping, or layout extraction is added.

### 7.2 Environment Variables

Create `backend/.env.example`:

```env
GEMINI_API_KEY=replace_me
GEMINI_MODEL=gemini-2.5-flash
BACKEND_BASE_URL=http://localhost:8000
MAX_RECOMMENDED_PAGES=50
TEMP_STORAGE_DIR=./tmp
ALLOW_ORIGINS=http://localhost:5173,chrome-extension://replace_me
```

The Google GenAI SDK can use `GEMINI_API_KEY` from the environment. Gemini supports PDF document understanding, and Google documents that the API can process PDF files through document understanding and file input methods. Use the official GenAI SDK and File API pattern.

### 7.3 API Endpoints

#### 7.3.1 Create Job From Local Upload

```http
POST /api/jobs/upload
Content-Type: multipart/form-data
```

Form fields:

```text
file: PDF file
force: boolean, default false
```

Behavior:

1. Validate file MIME type is `application/pdf`.
2. Save file temporarily.
3. Count pages using `pypdf`.
4. If pages are above `MAX_RECOMMENDED_PAGES` and `force` is false, return a warning response.
5. If acceptable or forced, process the PDF through Gemini.
6. Return job id, status, page count, warning if any, and result URL.

Warning response:

```json
{
  "status": "warning",
  "warning_type": "PAGE_LIMIT_EXCEEDED",
  "message": "This PDF has 72 pages. DocuSense is optimized for 50 pages or fewer in this prototype. You can continue, but processing may be slow or incomplete.",
  "page_count": 72,
  "can_continue": true
}
```

Success response:

```json
{
  "job_id": "uuid",
  "status": "completed",
  "page_count": 24,
  "result_url": "http://localhost:8000/api/results/uuid",
  "preview_html": "<main>...</main>"
}
```

#### 7.3.2 Create Job From URL

```http
POST /api/jobs/url
Content-Type: application/json
```

Request:

```json
{
  "url": "https://example.com/paper.pdf",
  "force": false
}
```

Behavior:

1. Validate URL scheme is `http` or `https`.
2. Download the PDF using `httpx`.
3. Enforce reasonable file size limit. Suggested initial limit is 25 MB.
4. Confirm response content type is PDF or file begins with PDF signature.
5. Continue with the same page count and processing flow as local upload.

#### 7.3.3 Get Result Page

```http
GET /api/results/{job_id}
```

Returns a complete HTML page. This page should be readable directly in Edge.

#### 7.3.4 Get Raw Result JSON

```http
GET /api/results/{job_id}/json
```

Returns debug metadata:

```json
{
  "job_id": "uuid",
  "title": "...",
  "language": "en",
  "page_count": 24,
  "html": "...",
  "created_at": "...",
  "processor": "gemini-2.5-flash"
}
```

### 7.4 Backend Processing Logic

Create a provider independent interface:

```python
from abc import ABC, abstractmethod

class DocumentProcessor(ABC):
    @abstractmethod
    async def process_pdf(self, pdf_path: str) -> dict:
        pass
```

Gemini implementation:

```python
class GeminiDocumentProcessor(DocumentProcessor):
    async def process_pdf(self, pdf_path: str) -> dict:
        ...
```

Future Azure implementation:

```python
class AzureDocumentProcessor(DocumentProcessor):
    async def process_pdf(self, pdf_path: str) -> dict:
        ...
```

The rest of the backend must call `DocumentProcessor`, not Gemini directly.

### 7.5 Gemini Processing Requirements

The Gemini processor must:

1. Upload or attach the PDF using the official Google GenAI SDK file input flow.
2. Use model `gemini-2.5-flash` by default.
3. Prompt the model to return valid semantic HTML only.
4. Preserve the original language.
5. Mirror the research paper section by section.
6. Extract title, authors, publisher or venue where available.
7. Reconstruct the intended reading order.
8. Explain figures, graphs, tables, and diagrams in context.
9. Remove repeated headers, footers, page numbers, and irrelevant metadata.
10. Keep references at the end.
11. Avoid unsupported scripts, inline event handlers, external CSS, and external JavaScript.

### 7.6 Gemini Prompt

Create `backend/app/prompts/accessible_html_prompt.txt`:

```text
You are DocuSense, an accessibility assistant for visually impaired students.

Convert the attached research paper PDF into screen reader friendly semantic HTML.

The output will be opened in Microsoft Edge and read using Edge Read Aloud or a screen reader.

Requirements:
1. Preserve the original language of the document. If the document is in Indonesian, write the result in Indonesian. If the document is in English, write the result in English.
2. Reconstruct the correct reading order, especially for multi column academic papers.
3. Mirror the paper section by section. Follow the original academic structure when possible, such as Abstract, Introduction, Methods, Results, Discussion, Conclusion, Acknowledgments, References, and Appendices.
4. Begin with an accessible introduction section containing document title, authors, publisher or venue if available, detected language, and a short note that this is a DocuSense accessible version.
5. Use only semantic HTML elements: html, head, title, meta, body, main, article, header, nav, section, h1, h2, h3, h4, p, ul, ol, li, table, thead, tbody, tr, th, td, figure, figcaption, blockquote, strong, em, sup, sub, code.
6. Create a navigation section near the top with links to major sections.
7. Explain figures, charts, diagrams, and important tables in text. Place explanations near the section where they appear.
8. If a visual element is unclear, describe only what can be inferred from the document and do not invent details.
9. Remove repeated headers, footers, standalone page numbers, and layout artifacts.
10. Keep references in a separate references section at the end.
11. Do not include Markdown fences.
12. Do not include JavaScript.
13. Do not include external CSS links.
14. Return only complete valid HTML.
```

### 7.7 HTML Sanitization

Even though the HTML is generated by the model, sanitize it before saving.

Allowed tags:

```python
ALLOWED_TAGS = [
    "html", "head", "title", "meta", "body", "main", "article", "header",
    "nav", "section", "h1", "h2", "h3", "h4", "p", "ul", "ol", "li",
    "table", "thead", "tbody", "tr", "th", "td", "figure", "figcaption",
    "blockquote", "strong", "em", "sup", "sub", "code", "a"
]
```

Allowed attributes:

```python
ALLOWED_ATTRIBUTES = {
    "html": ["lang"],
    "nav": ["aria-label"],
    "section": ["id", "aria-labelledby"],
    "a": ["href"],
    "th": ["scope"],
    "td": ["colspan", "rowspan"],
    "meta": ["charset", "name", "content"]
}
```

After sanitization, wrap output in the app result template if the model does not return a complete page.

## 8. Extension Specification

### 8.1 Extension Technology

Use React with Vite and Manifest V3.

The extension should be compatible with Microsoft Edge Chromium.

### 8.2 Extension Permissions

Required permissions:

```json
{
  "permissions": ["activeTab", "tabs", "scripting"],
  "host_permissions": ["http://localhost:8000/*", "https://*/*", "http://*/*"]
}
```

Use minimum permissions during development. For production, restrict host permissions where possible.

### 8.3 Extension UI

Use blue and white DocuSense branding.

Primary colors:

```css
:root {
  --docusense-blue: #123C7C;
  --docusense-light-blue: #2EA7E0;
  --docusense-bg: #F7FAFF;
  --docusense-text: #172033;
  --docusense-border: #D8E6F7;
}
```

Main UI sections:

1. Header with DocuSense logo text.
2. Short tagline: Transform inaccessible PDFs into screen reader friendly pages.
3. Current tab PDF detection card.
4. Button: Process Current PDF.
5. Divider text: or upload a local file.
6. File upload control.
7. Processing status area.
8. Warning modal for PDFs above 50 pages.
9. Result preview panel.
10. Button: Open Full Page.

### 8.4 Extension State Model

```ts
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
}
```

### 8.5 Extension Behavior

When extension opens:

1. Read the current active tab.
2. Check if the URL looks like a PDF URL.
3. If yes, show Process Current PDF.
4. If no, still allow local upload.

PDF URL detection:

```ts
function looksLikePdfUrl(url: string): boolean {
  return url.toLowerCase().includes(".pdf") || url.toLowerCase().startsWith("file://");
}
```

Important: for local `file://` URLs, do not try to fetch the file from the tab. Show a message asking the user to upload the file manually.

### 8.6 Result Display

The extension should display a small preview of the generated HTML. However, the main reading experience should be the full result page.

Reason:

1. Full page is easier for Edge Read Aloud.
2. Full page gives better screen reader navigation.
3. Side panel space is too small for long documents.

The extension should therefore support both:

1. Inline preview for quick confirmation.
2. Full result page for actual reading.

## 9. Accessibility Requirements

The extension itself must be accessible.

1. All buttons must have clear text labels.
2. All loading states must be announced visually and textually.
3. Avoid icon only buttons.
4. Use sufficient contrast.
5. Support keyboard navigation.
6. Do not rely on color alone to show status.
7. Use `aria-live="polite"` for processing status updates.
8. The result page must use headings in correct order.
9. The result page must include a navigation section.
10. Tables must use proper table elements.
11. Figure explanations must be written as text near the relevant figure section.

## 10. Error Handling

Backend errors should return structured JSON.

```json
{
  "status": "error",
  "error_code": "GEMINI_PROCESSING_FAILED",
  "message": "DocuSense could not process this PDF. Please try a shorter research paper or upload another file."
}
```

Required error codes:

```text
INVALID_FILE_TYPE
PDF_DOWNLOAD_FAILED
PDF_TOO_LARGE
PDF_PAGE_COUNT_FAILED
GEMINI_UPLOAD_FAILED
GEMINI_PROCESSING_FAILED
HTML_SANITIZATION_FAILED
RESULT_NOT_FOUND
UNKNOWN_ERROR
```

Extension should show friendly error messages and allow retry.

## 11. Security and Privacy Requirements

1. No sign in.
2. Do not store user documents permanently.
3. Store PDFs and generated HTML only in local temporary storage.
4. Generate random UUID job ids.
5. Do not expose file paths to the client.
6. Sanitize generated HTML before serving it.
7. Do not allow arbitrary JavaScript in generated HTML.
8. Validate remote PDF URLs.
9. Block internal network URLs in backend URL download logic to reduce SSRF risk.
10. Add file size limit. Suggested prototype limit is 25 MB.

## 12. Future Azure Migration Plan

The backend must keep the document processor abstract.

Current provider:

```text
GeminiDocumentProcessor
```

Future provider:

```text
AzureDocumentProcessor
```

Future Azure flow:

```text
PDF
    ↓
Azure Blob Storage
    ↓
Azure AI Document Intelligence
    ↓
Custom reading order engine
    ↓
Azure OpenAI Vision
    ↓
Azure OpenAI text generation
    ↓
Accessible HTML
```

The frontend should not change when the backend provider changes.

## 13. Development Tasks For AI Coding Agent

### Task 1: Create Repository Structure

Create the folder structure described in this spec.

### Task 2: Build FastAPI Backend Skeleton

Implement:

1. `main.py`
2. CORS setup
3. config loading
4. health check endpoint
5. job routes
6. result routes

### Task 3: Implement PDF Upload Processing

Implement local PDF upload endpoint with page count checking.

### Task 4: Implement PDF URL Processing

Implement URL based PDF download endpoint with validation and file size limit.

### Task 5: Implement Gemini Processor

Use the official Google GenAI SDK.

The processor should:

1. Upload PDF to Gemini.
2. Send the accessibility prompt.
3. Use `gemini-2.5-flash`.
4. Return generated HTML.

### Task 6: Implement Result Store

Save result HTML and metadata locally using job id.

Suggested files:

```text
backend/tmp/jobs/{job_id}/original.pdf
backend/tmp/jobs/{job_id}/result.html
backend/tmp/jobs/{job_id}/metadata.json
```

### Task 7: Implement HTML Sanitization

Sanitize model generated HTML and wrap it in a result page template.

### Task 8: Build React Extension

Implement Vite React extension with:

1. Header
2. Current tab PDF detection
3. Upload PDF input
4. Process current PDF button
5. Warning modal
6. Status view
7. Result preview
8. Open full result page button

### Task 9: Connect Extension To Backend

Create `api.ts` with functions:

```ts
processPdfUpload(file: File, force?: boolean)
processPdfUrl(url: string, force?: boolean)
```

### Task 10: Test Demo Flow

Test with:

1. A short English research paper PDF.
2. A short Indonesian research paper PDF.
3. A PDF above 50 pages to verify warning behavior.
4. A non PDF file to verify error behavior.
5. A PDF URL from the current tab.
6. A local PDF uploaded manually.

## 14. Acceptance Criteria

The prototype is complete when:

1. The Edge extension opens and shows DocuSense branding.
2. The user can upload a local PDF.
3. The user can process an online PDF URL from the current Edge tab.
4. PDFs above 50 pages show a warning but can continue.
5. Backend sends the PDF to Gemini 2.5 Flash.
6. Backend returns accessible semantic HTML.
7. Result page opens in Edge.
8. Result page includes title, authors, publisher or venue when available, and detected language.
9. Result page mirrors the paper section by section.
10. Result page preserves English or Indonesian based on the source document.
11. Result page can be read by Edge Read Aloud or a screen reader.
12. The code is structured so Gemini can later be replaced with Azure.

## 15. Important Implementation Notes

1. Build the local upload path first because it is the most reliable demo flow.
2. Build URL processing second.
3. Keep the result page full screen because it is better for reading tools.
4. Keep the extension preview short because long HTML inside a side panel is not the main experience.
5. Keep the Gemini prompt strict and ask for only valid HTML.
6. Sanitize the generated HTML before serving it.
7. Use a hard file size limit, but only warn for the 50 page recommendation.
8. Do not over engineer the backend job system. Synchronous processing is acceptable for the first hackathon prototype.
9. If processing takes too long, add a basic polling job system later.
10. Do not implement Azure until the prototype is stable.
