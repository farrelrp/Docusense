export interface ReaderChapter {
  id: string;
  label: string;
  html: string;
  text: string;
}

function getReadableHtml(element: Element): string {
  const clone = element.cloneNode(true) as Element;
  clone
    .querySelectorAll("[data-read-aloud-ui='true'], script, style, nav")
    .forEach((node) => node.remove());
  return clone.innerHTML.trim();
}

function getReadableText(element: Element): string {
  const clone = element.cloneNode(true) as Element;
  clone
    .querySelectorAll("[data-read-aloud-ui='true'], script, style, nav")
    .forEach((node) => node.remove());
  return clone.textContent?.replace(/\s+/g, " ").trim() ?? "";
}

function getHeadingText(element: Element, fallback: string): string {
  return (
    element.querySelector(":scope > h1, :scope > h2, :scope > h3, :scope > h4")?.textContent
      ?.replace(/\s+/g, " ")
      .trim() || fallback
  );
}

export function parseChapters(html: string): ReaderChapter[] {
  const documentHtml = new DOMParser().parseFromString(html, "text/html");
  const article =
    documentHtml.querySelector("main article") ??
    documentHtml.querySelector("article") ??
    documentHtml.body;
  const chapters: ReaderChapter[] = [];

  const documentInfoNodes = Array.from(article.children).filter((child) => {
    if (child.matches("[data-read-aloud-ui='true'], nav, section, script, style")) {
      return false;
    }
    return Boolean(getReadableText(child));
  });

  if (documentInfoNodes.length > 0) {
    const htmlFragment = documentInfoNodes
      .map((node) => {
        const clone = node.cloneNode(true) as Element;
        clone
          .querySelectorAll("[data-read-aloud-ui='true'], script, style, nav")
          .forEach((child) => child.remove());
        return clone.outerHTML;
      })
      .join("");
    const text = documentInfoNodes.map((node) => getReadableText(node)).filter(Boolean).join(". ");
    chapters.push({
      id: "document-information",
      label: "Document Information",
      html: htmlFragment,
      text,
    });
  }

  Array.from(article.querySelectorAll(":scope > section")).forEach((section, index) => {
    const text = getReadableText(section);
    if (!text) {
      return;
    }

    chapters.push({
      id: section.id || `chapter-${index + 1}`,
      label: getHeadingText(section, `Chapter ${index + 1}`),
      html: getReadableHtml(section),
      text,
    });
  });

  if (chapters.length === 0) {
    chapters.push({
      id: "document",
      label: "Document",
      html: getReadableHtml(article),
      text: getReadableText(article),
    });
  }

  return chapters;
}
