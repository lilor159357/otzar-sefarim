import fs from "fs";
import bwipjs from "bwip-js";
import fontkit from "@pdf-lib/fontkit";
import bidiFactory from "bidi-js";
import { PDFDocument, rgb } from "pdf-lib";

const bidi = bidiFactory();

const ltrFontkit = {
  ...fontkit,
  create(buffer: Uint8Array, postscriptName?: string) {
    const font = (fontkit as any).create(buffer, postscriptName);
    const origLayout = font.layout.bind(font);
    font.layout = (
      str: string,
      userFeatures?: any,
      script?: string,
      language?: string
    ) => origLayout(str, userFeatures, script, language, "ltr");
    return font;
  },
};
const MM_TO_PT = 72 / 25.4;
const A4_WIDTH_MM = 210;
const A4_HEIGHT_MM = 297;

export interface A4TemplateConfig {
  rows: number;
  cols: number;
  marginTopMm: number;
  marginRightMm: number;
  marginBottomMm: number;
  marginLeftMm: number;
  gapXMm: number;
  gapYMm: number;
}

export interface LabelDesignConfig {
  showLibraryName: boolean;
  showBookTitle: boolean;
  showLocation: boolean;
}

export interface LabelBookInput {
  barcode: string;
  title: string;
  volume?: string;
  cabinet_code?: string | null;
  shelf_number?: number | null;
}

export interface GenerateLabelsPdfParams {
  books: LabelBookInput[];
  libraryName: string;
  template: A4TemplateConfig;
  design: LabelDesignConfig;
  startPosition?: number; // 1-based slot on first page
  drawGuides?: boolean;
}

function findHebrewFontPath(): string {
  const candidates = [
    "C:\\Windows\\Fonts\\arial.ttf",
    "C:\\Windows\\Fonts\\tahoma.ttf",
    "C:\\Windows\\Fonts\\david.ttf",
    "C:\\Windows\\Fonts\\segoeui.ttf",
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  throw new Error("לא נמצא גופן עברי (Arial/Tahoma/David) בתיקיית הגופנים של Windows");
}

function toVisualLtr(logical: string): string {
  if (!logical) return "";
  const levels = bidi.getEmbeddingLevels(logical, "rtl");
  return bidi.getReorderedString(logical, levels);
}

function fitVisualLine(font: any, rawLogical: string, fontSize: number, maxWidthPt: number): string {
  let logical = String(rawLogical || "").replace(/[\r\n]+/g, " ").trim();
  if (!logical) return "";
  const fullVisual = toVisualLtr(logical);
  if (font.widthOfTextAtSize(fullVisual, fontSize) <= maxWidthPt) return fullVisual;

  while (logical.length > 3) {
    logical = logical.slice(0, -1).trim();
    const visWithEllipsis = toVisualLtr(logical + "…");
    if (font.widthOfTextAtSize(visWithEllipsis, fontSize) <= maxWidthPt) {
      return visWithEllipsis;
    }
  }
  return toVisualLtr(logical);
}

export async function generateLabelsPdfBuffer(params: GenerateLabelsPdfParams): Promise<Uint8Array> {
  const { books, libraryName, template, design } = params;
  const rows = Math.max(1, Math.min(20, Number(template.rows) || 8));
  const cols = Math.max(1, Math.min(8, Number(template.cols) || 3));
  const marginTop = Math.max(0, Number(template.marginTopMm) || 0);
  const marginBottom = Math.max(0, Number(template.marginBottomMm) || 0);
  const marginLeft = Math.max(0, Number(template.marginLeftMm) || 0);
  const marginRight = Math.max(0, Number(template.marginRightMm) || 0);
  const gapX = Math.max(0, Number(template.gapXMm) || 0);
  const gapY = Math.max(0, Number(template.gapYMm) || 0);

  const cellWidthMm = (A4_WIDTH_MM - marginLeft - marginRight - (cols - 1) * gapX) / cols;
  const cellHeightMm = (A4_HEIGHT_MM - marginTop - marginBottom - (rows - 1) * gapY) / rows;
  if (cellWidthMm <= 12 || cellHeightMm <= 10) {
    throw new Error("מידות הגיליון משאירות שטח קטן מדי לכל מדבקה. הקטן שוליים או מספר עמודות/שורות.");
  }

  const pdfDoc = await PDFDocument.create();
  pdfDoc.registerFontkit(ltrFontkit as any);
  const fontBytes = fs.readFileSync(findHebrewFontPath());
  const hebrewFont = await pdfDoc.embedFont(fontBytes, { subset: true });

  const perPage = rows * cols;
  let slotIndex = Math.max(0, Math.min(perPage - 1, (Number(params.startPosition) || 1) - 1));
  let page = pdfDoc.addPage([A4_WIDTH_MM * MM_TO_PT, A4_HEIGHT_MM * MM_TO_PT]);

  for (let idx = 0; idx < books.length; idx++) {
    if (slotIndex >= perPage) {
      page = pdfDoc.addPage([A4_WIDTH_MM * MM_TO_PT, A4_HEIGHT_MM * MM_TO_PT]);
      slotIndex = 0;
    }

    const book = books[idx];
    const row = Math.floor(slotIndex / cols);
    const rtlColFromRight = slotIndex % cols;
    const colFromLeft = cols - 1 - rtlColFromRight;

    const cellLeftMm = marginLeft + colFromLeft * (cellWidthMm + gapX);
    const cellTopMm = marginTop + row * (cellHeightMm + gapY);

    const xPt = cellLeftMm * MM_TO_PT;
    const wPt = cellWidthMm * MM_TO_PT;
    const hPt = cellHeightMm * MM_TO_PT;
    const yBottomPt = (A4_HEIGHT_MM - cellTopMm - cellHeightMm) * MM_TO_PT;
    const yTopPt = yBottomPt + hPt;

    if (params.drawGuides) {
      page.drawRectangle({
        x: xPt,
        y: yBottomPt,
        width: wPt,
        height: hPt,
        borderColor: rgb(0.82, 0.82, 0.82),
        borderWidth: 0.5,
      });
    }

    const padX = 4;
    const maxTextWidth = Math.max(20, wPt - padX * 2);
    let cursorTopPt = yTopPt - 5;

    // Optional library name
    if (design.showLibraryName && libraryName) {
      const size = 7;
      const visLib = fitVisualLine(hebrewFont, libraryName, size, maxTextWidth);
      const tw = hebrewFont.widthOfTextAtSize(visLib, size);
      cursorTopPt -= size;
      page.drawText(visLib, {
        x: xPt + (wPt - tw) / 2,
        y: cursorTopPt,
        size,
        font: hebrewFont,
        color: rgb(0.32, 0.36, 0.44),
      });
      cursorTopPt -= 2;
    }

    // Optional book title (+ volume)
    if (design.showBookTitle && book.title) {
      const size = 8.5;
      const fullTitle = book.volume ? `${book.title} (${book.volume})` : book.title;
      const visTitle = fitVisualLine(hebrewFont, fullTitle, size, maxTextWidth);
      const tw = hebrewFont.widthOfTextAtSize(visTitle, size);
      cursorTopPt -= size;
      page.drawText(visTitle, {
        x: xPt + (wPt - tw) / 2,
        y: cursorTopPt,
        size,
        font: hebrewFont,
        color: rgb(0.08, 0.11, 0.16),
      });
      cursorTopPt -= 3;
    }

    // Reserve footer space if showLocation
    const footerReservePt = design.showLocation ? 12 : 4;
    const availBarcodeHeightPt = Math.max(18, cursorTopPt - (yBottomPt + footerReservePt));

    // Crisp Code 128 barcode PNG via bwip-js
    const pngBuffer: Buffer = await bwipjs.toBuffer({
      bcid: "code128",
      text: String(book.barcode),
      scale: 3,
      height: 11,
      includetext: true,
      textxalign: "center",
      textsize: 9,
      paddingwidth: 4,
      paddingheight: 2,
      backgroundcolor: "FFFFFF",
    });

    const pngImage = await pdfDoc.embedPng(pngBuffer);
    const maxBwPt = wPt - 10;
    const scale = Math.min(maxBwPt / pngImage.width, availBarcodeHeightPt / pngImage.height);
    const drawBw = pngImage.width * scale;
    const drawBh = pngImage.height * scale;
    const barcodeY = yBottomPt + footerReservePt + Math.max(0, (availBarcodeHeightPt - drawBh) / 2);

    page.drawImage(pngImage, {
      x: xPt + (wPt - drawBw) / 2,
      y: barcodeY,
      width: drawBw,
      height: drawBh,
    });

    // Optional location line
    if (design.showLocation) {
      const locStr = book.cabinet_code
        ? `ארון ${book.cabinet_code} · מדף ${book.shelf_number ?? "-"}`
        : "ללא שיוך ארון";
      const size = 7.5;
      const visLoc = fitVisualLine(hebrewFont, locStr, size, maxTextWidth);
      const tw = hebrewFont.widthOfTextAtSize(visLoc, size);
      page.drawText(visLoc, {
        x: xPt + (wPt - tw) / 2,
        y: yBottomPt + 3.5,
        size,
        font: hebrewFont,
        color: rgb(0.25, 0.28, 0.35),
      });
    }

    slotIndex++;
  }

  return pdfDoc.save();
}
