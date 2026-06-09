from __future__ import annotations

import re

import bleach
from bs4 import BeautifulSoup, Doctype

from app.services.errors import DocuSenseError

ALLOWED_TAGS = [
    "html",
    "head",
    "title",
    "meta",
    "body",
    "main",
    "article",
    "header",
    "nav",
    "section",
    "h1",
    "h2",
    "h3",
    "h4",
    "p",
    "ul",
    "ol",
    "li",
    "table",
    "thead",
    "tbody",
    "tr",
    "th",
    "td",
    "figure",
    "figcaption",
    "blockquote",
    "strong",
    "em",
    "sup",
    "sub",
    "code",
    "a",
]

ALLOWED_ATTRIBUTES = {
    "html": ["lang"],
    "nav": ["aria-label"],
    "section": ["id", "aria-labelledby"],
    "a": ["href"],
    "th": ["scope"],
    "td": ["colspan", "rowspan"],
    "meta": ["charset", "name", "content"],
}

READER_PLAYER_HTML = """
<aside class="docuse-reader-player" id="docuse-reader-player" aria-label="Read aloud controls" data-read-aloud-ui="true">
  <div class="docuse-reader-controls">
    <button type="button" id="docuse-reader-play" aria-label="Play document">Play</button>
    <button type="button" id="docuse-reader-pause" aria-label="Pause document" disabled>Pause</button>
    <button type="button" id="docuse-reader-stop" aria-label="Stop document" disabled>Stop</button>
    <label for="docuse-reader-rate">Speed</label>
    <input id="docuse-reader-rate" type="range" min="0.7" max="1.6" value="1" step="0.1" aria-label="Reading speed">
    <output id="docuse-reader-rate-value" for="docuse-reader-rate">1.0x</output>
  </div>
  <div class="docuse-reader-progress" aria-live="polite">
    <progress id="docuse-reader-progress" max="100" value="0">0%</progress>
    <span id="docuse-reader-status">Ready to read this document aloud.</span>
  </div>
</aside>
"""

READER_PLAYER_CSS = """
:root {
  color-scheme: light;
  font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  line-height: 1.6;
}

body {
  margin: 0;
  background: #f7f7f4;
  color: #202124;
}

main {
  box-sizing: border-box;
  max-width: 72ch;
  margin: 0 auto;
  padding: 2rem 1rem 4rem;
}

article {
  background: #ffffff;
  border: 1px solid #d8d7d2;
  border-radius: 6px;
  padding: clamp(1rem, 3vw, 2.5rem);
}

h1,
h2,
h3,
h4 {
  line-height: 1.25;
}

table {
  border-collapse: collapse;
  display: block;
  max-width: 100%;
  overflow-x: auto;
}

th,
td {
  border: 1px solid #c9c8c3;
  padding: 0.5rem;
  vertical-align: top;
}

.docuse-reader-player {
  position: sticky;
  top: 0;
  z-index: 10;
  box-sizing: border-box;
  border-bottom: 1px solid #c9c8c3;
  background: #ffffff;
  padding: 0.75rem 1rem;
  box-shadow: 0 1px 8px rgba(32, 33, 36, 0.08);
}

.docuse-reader-controls,
.docuse-reader-progress {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.5rem;
  max-width: 72rem;
  margin: 0 auto;
}

.docuse-reader-progress {
  margin-top: 0.5rem;
}

.docuse-reader-player button {
  min-height: 2.25rem;
  border: 1px solid #6d6f73;
  border-radius: 4px;
  background: #202124;
  color: #ffffff;
  padding: 0 0.8rem;
  font: inherit;
  cursor: pointer;
}

.docuse-reader-player button:disabled {
  cursor: not-allowed;
  opacity: 0.45;
}

.docuse-reader-player input[type="range"] {
  width: min(12rem, 45vw);
}

.docuse-reader-player progress {
  flex: 1 1 12rem;
  min-width: 10rem;
  height: 0.75rem;
}

#docuse-reader-status {
  flex: 999 1 18rem;
}
"""

READER_PLAYER_JS = """
(() => {
  const synth = window.speechSynthesis;
  const player = document.getElementById("docuse-reader-player");
  const playButton = document.getElementById("docuse-reader-play");
  const pauseButton = document.getElementById("docuse-reader-pause");
  const stopButton = document.getElementById("docuse-reader-stop");
  const rateInput = document.getElementById("docuse-reader-rate");
  const rateValue = document.getElementById("docuse-reader-rate-value");
  const progress = document.getElementById("docuse-reader-progress");
  const status = document.getElementById("docuse-reader-status");

  if (!synth || !window.SpeechSynthesisUtterance) {
    status.textContent = "This browser does not support in-page read aloud controls.";
    playButton.disabled = true;
    return;
  }

  const readableRoot = document.querySelector("main article") || document.querySelector("article") || document.querySelector("main") || document.body;
  const text = Array.from(readableRoot.querySelectorAll("h1, h2, h3, h4, p, li, figcaption, blockquote, th, td"))
    .filter((node) => !node.closest("[data-read-aloud-ui='true'], script, style"))
    .map((node) => node.textContent.trim())
    .filter(Boolean)
    .join("\\n\\n");

  let utterance = null;
  let started = false;

  function setPlaying(isPlaying) {
    playButton.disabled = isPlaying;
    pauseButton.disabled = !isPlaying;
    stopButton.disabled = !isPlaying && !synth.paused;
  }

  function reset() {
    started = false;
    utterance = null;
    progress.value = 0;
    status.textContent = "Ready to read this document aloud.";
    setPlaying(false);
    stopButton.disabled = true;
  }

  function speak() {
    if (synth.paused && started) {
      synth.resume();
      status.textContent = "Reading resumed.";
      setPlaying(true);
      return;
    }

    if (!text) {
      status.textContent = "No readable document text was found.";
      return;
    }

    synth.cancel();
    utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = document.documentElement.lang || "en";
    utterance.rate = Number(rateInput.value);
    utterance.onstart = () => {
      started = true;
      status.textContent = "Reading document aloud.";
      setPlaying(true);
    };
    utterance.onboundary = (event) => {
      if (event.name === "word" && text.length > 0) {
        progress.value = Math.min(100, Math.round((event.charIndex / text.length) * 100));
      }
    };
    utterance.onend = reset;
    utterance.onerror = () => {
      status.textContent = "Read aloud stopped before finishing.";
      setPlaying(false);
    };
    synth.speak(utterance);
  }

  playButton.addEventListener("click", speak);
  pauseButton.addEventListener("click", () => {
    synth.pause();
    status.textContent = "Reading paused.";
    playButton.disabled = false;
    pauseButton.disabled = true;
    stopButton.disabled = false;
  });
  stopButton.addEventListener("click", () => {
    synth.cancel();
    reset();
  });
  rateInput.addEventListener("input", () => {
    rateValue.textContent = `${Number(rateInput.value).toFixed(1)}x`;
    if (started) {
      status.textContent = "Speed will apply the next time playback starts.";
    }
  });
  window.addEventListener("pagehide", () => synth.cancel());
})();
"""


def _link_filter(tag: str, name: str, value: str) -> bool:
    if tag == "a" and name == "href":
        return value.startswith("#")
    return name in ALLOWED_ATTRIBUTES.get(tag, [])


def sanitize_html(raw_html: str) -> str:
    try:
        raw_html = remove_unsafe_elements(raw_html)
        cleaned = bleach.clean(
            raw_html,
            tags=ALLOWED_TAGS,
            attributes=_link_filter,
            strip=True,
            strip_comments=True,
        )
    except Exception as exc:
        raise DocuSenseError(
            "HTML_SANITIZATION_FAILED",
            "DocuSense could not sanitize the generated HTML.",
            status_code=500,
        ) from exc

    if not cleaned.strip():
        raise DocuSenseError(
            "HTML_SANITIZATION_FAILED",
            "Gemini returned empty HTML after sanitization.",
            status_code=500,
        )

    return enhance_readable_result_page(normalize_result_page(cleaned))


def remove_unsafe_elements(raw_html: str) -> str:
    soup = BeautifulSoup(raw_html, "html.parser")
    for node in soup.find_all(["script", "style", "iframe", "object", "embed"]):
        node.decompose()
    return str(soup)


def normalize_result_page(html: str) -> str:
    soup = BeautifulSoup(html, "html.parser")

    html_tag = soup.find("html")
    if html_tag is None:
        language = detect_language(soup)
        body_content = str(soup)
        return build_result_page(body_content, language)

    if not html_tag.get("lang"):
        html_tag["lang"] = detect_language(soup)

    if soup.head is None:
        head = soup.new_tag("head")
        soup.html.insert(0, head)
    if soup.head.find("meta", attrs={"charset": True}) is None:
        meta = soup.new_tag("meta", charset="utf-8")
        soup.head.insert(0, meta)
    if soup.head.find("title") is None:
        title = soup.new_tag("title")
        title.string = extract_title(str(soup)) or "DocuSense Accessible Document"
        soup.head.append(title)

    if soup.body is None:
        body = soup.new_tag("body")
        for child in list(soup.html.children):
            if getattr(child, "name", None) != "head":
                body.append(child.extract())
        soup.html.append(body)

    return "<!doctype html>\n" + str(soup)


def enhance_readable_result_page(html: str) -> str:
    soup = BeautifulSoup(html, "html.parser")
    for item in list(soup.contents):
        if isinstance(item, Doctype):
            item.extract()

    if soup.head is None:
        head = soup.new_tag("head")
        if soup.html:
            soup.html.insert(0, head)
        else:
            soup.insert(0, head)

    if soup.head.find("meta", attrs={"name": "viewport"}) is None:
        viewport = soup.new_tag(
            "meta",
            attrs={"name": "viewport", "content": "width=device-width, initial-scale=1"},
        )
        soup.head.append(viewport)

    if soup.head.find("meta", attrs={"name": "docuse-reader"}) is None:
        marker = soup.new_tag(
            "meta",
            attrs={
                "name": "docuse-reader",
                "content": "Semantic article HTML with an optional Web Speech player.",
            },
        )
        soup.head.append(marker)

    if soup.body is None:
        body = soup.new_tag("body")
        if soup.html:
            soup.html.append(body)
        else:
            soup.append(body)

    if soup.body.find("main") is None:
        main = soup.new_tag("main")
        for child in list(soup.body.children):
            main.append(child.extract())
        soup.body.append(main)

    main = soup.body.find("main")
    if main and main.find("article") is None:
        article = soup.new_tag("article")
        for child in list(main.children):
            article.append(child.extract())
        main.append(article)

    ensure_document_information(soup)

    if soup.head.find("style", id="docuse-reader-style") is None:
        style = soup.new_tag("style", id="docuse-reader-style")
        style.string = READER_PLAYER_CSS
        soup.head.append(style)

    if soup.body.find(id="docuse-reader-player") is None:
        player = BeautifulSoup(READER_PLAYER_HTML, "html.parser")
        soup.body.insert(0, player)

    if soup.body.find("script", id="docuse-reader-script") is None:
        script = soup.new_tag("script", id="docuse-reader-script")
        script.string = READER_PLAYER_JS
        soup.body.append(script)

    return "<!doctype html>\n" + str(soup)


def ensure_document_information(soup: BeautifulSoup) -> None:
    article = soup.select_one("main article") or soup.find("article")
    if article is None:
        return

    for section in list(article.find_all("section")):
        heading = section.find(["h1", "h2", "h3", "h4"])
        if section.get("id") == "document-information" or (
            heading and heading.get_text(" ", strip=True).lower() == "document information"
        ):
            section.decompose()

    title = extract_title(str(article)) or "Untitled document"
    authors = extract_authors(article, title)
    publisher = extract_publisher(article)

    details = [f'This document is titled "{title}".']
    if authors:
        details.append(f"It was authored by {authors}.")
    if publisher:
        details.append(f"It was published by {publisher}.")

    section = soup.new_tag("section", id="document-information")
    heading = soup.new_tag("h2")
    heading.string = "Document Information"
    paragraph = soup.new_tag("p")
    paragraph.string = " ".join(details)
    section.append(heading)
    section.append(paragraph)
    article.insert(0, section)


def extract_authors(article, title: str) -> str:
    for node in article.find_all(["p", "div", "header"], recursive=True):
        text = clean_metadata_text(node.get_text(" ", strip=True))
        if not text or text == title or "@" in text:
            continue
        if re.search(r"\b(publisher|detected language|arxiv|preprint|abstract)\b", text, re.I):
            continue
        if "," in text and len(re.findall(r"\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)+\b", text)) >= 2:
            return text.rstrip(".")
    return ""


def extract_publisher(article) -> str:
    raw_text = article.get_text("\n", strip=True)
    text = clean_metadata_text(raw_text)
    publisher_match = re.search(
        r"\bPublisher:\s*(.+?)(?:\s+Detected Language:|\s+arXiv\b|\s+Preprint:|\n|$)",
        text,
        re.I,
    )
    if publisher_match:
        return clean_metadata_text(publisher_match.group(1)).rstrip(".")

    for line in raw_text.splitlines():
        clean_line = clean_metadata_text(line)
        if not clean_line or "@" in clean_line:
            continue
        if re.search(r"\b(research|university|institute|laboratory|lab|conference|journal)\b", clean_line, re.I):
            return clean_line.rstrip(".")
    return ""


def clean_metadata_text(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip()


def build_result_page(body_content: str, language: str) -> str:
    title = extract_title(body_content) or "DocuSense Accessible Document"
    return (
        "<!doctype html>\n"
        f'<html lang="{language}">\n'
        "<head>\n"
        '  <meta charset="utf-8">\n'
        f"  <title>{bleach.clean(title, tags=[], strip=True)}</title>\n"
        "</head>\n"
        "<body>\n"
        f"{body_content}\n"
        "</body>\n"
        "</html>\n"
    )


def extract_metadata(
    html: str,
    page_count: int,
    processor: str,
    job_id: str,
    requested_processor: str = "",
    processing_goal: str = "reading_order_repair",
    processing_stages: list[str] | None = None,
    stage_timings_ms: dict[str, int] | None = None,
    stage_statuses: dict[str, str] | None = None,
    stage_results: list[dict] | None = None,
) -> dict:
    soup = BeautifulSoup(html, "html.parser")
    title = extract_title(html) or "Untitled document"
    language = (soup.find("html") or {}).get("lang", "en")
    return {
        "job_id": job_id,
        "title": title,
        "language": language,
        "page_count": page_count,
        "html": html,
        "processor": processor,
        "requested_processor": requested_processor or processor,
        "processing_goal": processing_goal,
        "processing_stages": processing_stages or [],
        "stage_timings_ms": stage_timings_ms or {},
        "stage_statuses": stage_statuses or {},
        "stage_results": stage_results or [],
    }


def extract_title(html: str) -> str:
    soup = BeautifulSoup(html, "html.parser")
    for selector in ("h1", "title"):
        node = soup.find(selector)
        if node:
            title = node.get_text(" ", strip=True)
            if title:
                return title
    return ""


def detect_language(soup: BeautifulSoup) -> str:
    text = soup.get_text(" ", strip=True).lower()
    indonesian_markers = [
        "abstrak",
        "pendahuluan",
        "kesimpulan",
        "daftar pustaka",
        "penelitian",
    ]
    if any(re.search(rf"\b{re.escape(marker)}\b", text) for marker in indonesian_markers):
        return "id"
    return "en"
