/**
 * Utilities for handling and embedding web fonts and icon fonts.
 * @module fonts
 */

import { extractURL} from "../utils"
import { cache } from "../core/cache"
import { isIconFont } from '../modules/iconFonts.js';

/**
 * Converts a unicode character from an icon font into a data URL image.
 *
 * @export
 * @param {string} unicodeChar - The unicode character to render
 * @param {string} fontFamily - The font family name
 * @param {string|number} fontWeight - The font weight
 * @param {number} [fontSize=32] - The font size in pixels
 * @param {string} [color="#000"] - The color to use
 * @returns {Promise<string>} Data URL of the rendered icon
 */

export async function iconToImage(unicodeChar, fontFamily, fontWeight, fontSize = 32, color = "#000") {
  fontFamily = fontFamily.replace(/^['"]+|['"]+$/g, "");
  const dpr = window.devicePixelRatio || 1;

  // Asegurar que la fuente esté cargada (para evitar medidas incorrectas)
  await document.fonts.ready;

  // Crear span oculto para medir tamaño real
  const span = document.createElement("span");
  span.textContent = unicodeChar;
  span.style.position = "absolute";
  span.style.visibility = "hidden";
  span.style.fontFamily = `"${fontFamily}"`;
  span.style.fontWeight = fontWeight || "normal";
  span.style.fontSize = `${fontSize}px`;
  span.style.lineHeight = "1";
  span.style.whiteSpace = "nowrap";
  span.style.padding = "0";
  span.style.margin = "0";
  document.body.appendChild(span);

  const rect = span.getBoundingClientRect();
  const width = Math.ceil(rect.width);
  const height = Math.ceil(rect.height);
  document.body.removeChild(span);

  // Crear canvas del tamaño medido
  const canvas = document.createElement("canvas");
  canvas.width = width * dpr;
  canvas.height = height * dpr;

  const ctx = canvas.getContext("2d");
  ctx.scale(dpr, dpr);
  ctx.font = fontWeight ? `${fontWeight} ${fontSize}px "${fontFamily}"` : `${fontSize}px "${fontFamily}"`;
  ctx.textAlign = "left";
  ctx.textBaseline = "top"; // Alineado exacto con getBoundingClientRect
  ctx.fillStyle = color;
  ctx.fillText(unicodeChar, 0, 0);

  return {
    dataUrl: canvas.toDataURL(),
    width,
    height
  };
}


function isStylesheetLoaded(href) {
  return Array.from(document.styleSheets).some(sheet => sheet.href === href);
}

function injectLinkIfMissing(href) {
  return new Promise((resolve) => {
    if (isStylesheetLoaded(href)) return resolve(null);
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = href;
    link.setAttribute("data-snapdom", "injected-import");
    link.onload = () => resolve(link);
    link.onerror = () => resolve(null);
    document.head.appendChild(link);
  });
}

/**
 * Embeds custom fonts found in the document as data URLs in CSS.
 *
 * @export
 * @param {Object} options
 * @param {boolean} [options.preCached=false] - Whether to use pre-cached resources
 * @returns {Promise<string>} The inlined CSS for custom fonts
 */

export async function embedCustomFonts({preCached = false } = {}) {
  if (cache.resource.has("fonts-embed-css")) {
    if (preCached) {
      const style = document.createElement("style");
      style.setAttribute("data-snapdom", "embedFonts");
      style.textContent = cache.resource.get("fonts-embed-css");
      document.head.appendChild(style);
    }
    return cache.resource.get("fonts-embed-css");
  }

  const importRegex = /@import\s+url\(["']?([^"')]+)["']?\)/g;
  const styleImports = [];

  for (const styleTag of document.querySelectorAll("style")) {
    const cssText = styleTag.textContent || "";
    const matches = Array.from(cssText.matchAll(importRegex));
    for (const match of matches) {
      const importUrl = match[1];
      if (isIconFont(importUrl)) continue;
      if (!isStylesheetLoaded(importUrl)) {
        styleImports.push(importUrl);
      }
    }
  }

  await Promise.all(styleImports.map(injectLinkIfMissing));

  const links = Array.from(document.querySelectorAll('link[rel="stylesheet"]')).filter((link) => link.href);
  let finalCSS = "";

  for (const link of links) {
    try {
      const res = await fetch(link.href);
      const cssText = await res.text();

      if ((isIconFont(link.href) || isIconFont(cssText))) continue;

      const urlRegex = /url\((["']?)([^"')]+)\1\)/g;
      const inlinedCSS = await Promise.all(
        Array.from(cssText.matchAll(urlRegex)).map(async (match) => {
          let rawUrl = extractURL(match[0]);
          if (!rawUrl) return null;
          let url = rawUrl;
          if (!url.startsWith("http") && !url.startsWith("data:")) {
            url = new URL(url, link.href).href;
          }
          if (isIconFont(url)) return null;
          if (cache.resource.has(url)) {
            cache.font.add(url);
            return { original: match[0], inlined: `url(${cache.resource.get(url)})` };
          }
          if (cache.font.has(url)) return null;
          try {
            const fontRes = await fetch(url);
            const blob = await fontRes.blob();
            const b64 = await new Promise((resolve) => {
              const reader = new FileReader();
              reader.onload = () => resolve(reader.result);
              reader.readAsDataURL(blob);
            });
            cache.resource.set(url, b64);
            cache.font.add(url);
            return { original: match[0], inlined: `url(${b64})` };
          } catch (e) {
            console.warn("[snapdom] Failed to fetch font resource:", url);
            return null;
          }
        })
      );

      let cssFinal = cssText;
      for (const r of inlinedCSS) {
        if (r) cssFinal = cssFinal.replace(r.original, r.inlined);
      }
      finalCSS += cssFinal + "\n";
    } catch (e) {
      console.warn("[snapdom] Failed to fetch CSS:", link.href);
    }
  }

  for (const sheet of document.styleSheets) {
    try {
      if (!sheet.href || links.every((link) => link.href !== sheet.href)) {
        for (const rule of sheet.cssRules) {
          if (rule.type === CSSRule.FONT_FACE_RULE) {
            const src = rule.style.getPropertyValue("src");
            const family = rule.style.getPropertyValue("font-family");
            if (!src || isIconFont(family)) continue;

            const urlRegex = /url\((["']?)([^"')]+)\1\)/g;
            const localRegex = /local\((["']?)[^)]+?\1\)/g;
            const hasURL = !!src.match(urlRegex);
            const hasLocal = !!src.match(localRegex);

            if (!hasURL && hasLocal) {
              // Solo local(), conservar en línea compacta
              finalCSS += `@font-face{font-family:${family};src:${src};font-style:${rule.style.getPropertyValue("font-style") || "normal"};font-weight:${rule.style.getPropertyValue("font-weight") || "normal"};}`;
              continue;
            }

            // Embebido para src con url()
            let inlinedSrc = src;
            const matches = Array.from(src.matchAll(urlRegex));
            for (const match of matches) {
              let rawUrl = match[2].trim();
              if (!rawUrl) continue;
              let url = rawUrl;
              if (!url.startsWith("http") && !url.startsWith("data:")) {
                url = new URL(url, sheet.href || location.href).href;
              }
              if (isIconFont(url)) continue;
              if (cache.resource.has(url)) {
                cache.font.add(url);
                inlinedSrc = inlinedSrc.replace(match[0], `url(${cache.resource.get(url)})`);
                continue;
              }
              if (cache.font.has(url)) continue;
              try {
                const res = await fetch(url);
                const blob = await res.blob();
                const b64 = await new Promise((resolve) => {
                  const reader = new FileReader();
                  reader.onload = () => resolve(reader.result);
                  reader.readAsDataURL(blob);
                });
                cache.resource.set(url, b64);
                cache.font.add(url);
                inlinedSrc = inlinedSrc.replace(match[0], `url(${b64})`);
              } catch (e) {
                console.warn("[snapdom] Failed to fetch font URL:", url);
              }
            }

            finalCSS += `@font-face{font-family:${family};src:${inlinedSrc};font-style:${rule.style.getPropertyValue("font-style") || "normal"};font-weight:${rule.style.getPropertyValue("font-weight") || "normal"};}`;
          }
        }
      }
    } catch (e) {
      console.warn("[snapdom] Cannot access stylesheet", sheet.href, e);
    }
  }

  for (const font of document.fonts) {
    if (font.family && font.status === "loaded" && font._snapdomSrc) {
      if (isIconFont(font.family)) continue;
      let b64 = font._snapdomSrc;
      if (!b64.startsWith("data:")) {
        if (cache.resource.has(font._snapdomSrc)) {
          b64 = cache.resource.get(font._snapdomSrc);
          cache.font.add(font._snapdomSrc);
        } else if (!cache.font.has(font._snapdomSrc)) {
          try {
            const res = await fetch(font._snapdomSrc);
            const blob = await res.blob();
            b64 = await new Promise((resolve) => {
              const reader = new FileReader();
              reader.onload = () => resolve(reader.result);
              reader.readAsDataURL(blob);
            });
            cache.resource.set(font._snapdomSrc, b64);
            cache.font.add(font._snapdomSrc);
          } catch (e) {
            console.warn("[snapdom] Failed to fetch dynamic font src:", font._snapdomSrc);
            continue;
          }
        }
      }

      finalCSS += `@font-face{font-family:'${font.family}';src:url(${b64});font-style:${font.style || "normal"};font-weight:${font.weight || "normal"};}`;
    }
  }

  if (finalCSS) {
    cache.resource.set("fonts-embed-css", finalCSS);
    if (preCached) {
      const style = document.createElement("style");
      style.setAttribute("data-snapdom", "embedFonts");
      style.textContent = finalCSS;
      document.head.appendChild(style);
    }
  }

  return finalCSS;
}
