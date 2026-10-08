export function applyContent(content, document) {
  document.title = content.title;
  for (const [id, key] of Object.entries({
    brand: "title", tagline: "tagline", heading: "heading",
    introduction: "introduction", disclaimer: "disclaimer"
  })) document.getElementById(id).textContent = content[key];
}

export async function loadPageContent(document, request = fetch) {
  const notice = document.getElementById("content-notice");
  try {
    const response = await request("/api/content", { cache: "no-store", signal: AbortSignal.timeout(7000) });
    if (!response.ok) throw new Error(`Page content returned HTTP ${response.status}.`);
    const result = await response.json();
    applyContent(result.content, document);
    if (result.warning) { notice.textContent = result.warning; notice.hidden = false; }
  } catch (error) {
    console.error("Page text could not be refreshed:", error.message);
    notice.textContent = "Latest page text could not be loaded. Showing bundled text; reload to try again.";
    notice.hidden = false;
  }
}
