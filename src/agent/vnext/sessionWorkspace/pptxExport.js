/**
 * Plate → native Office Open XML PPTX (zip + ppt/presentation.xml).
 * Semantic mapping, not DOM scrape / HTML-deck-as-pptx.
 */

import { htmlRichFlow, imagePixelSize, isDarkHex } from './htmlMedia.js';

const PPTX_MIME =
  'application/vnd.openxmlformats-officedocument.presentationml.presentation';

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    c ^= bytes[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return (c ^ 0xffffffff) >>> 0;
}

function concatBytes(parts) {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

function u16(n) {
  const b = new Uint8Array(2);
  new DataView(b.buffer).setUint16(0, n, true);
  return b;
}

function u32(n) {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n >>> 0, true);
  return b;
}

/**
 * ZIP STORE (method 0) so validateArtifactBytes can read local headers.
 * @param {Array<{ name: string, data: Uint8Array|string }>} files
 */
export function buildZipStore(files) {
  const enc = new TextEncoder();
  const chunks = [];
  const centrals = [];
  let offset = 0;
  for (const f of files) {
    const nameBytes = enc.encode(f.name.replace(/\\/g, '/'));
    const data =
      f.data instanceof Uint8Array ? f.data : enc.encode(String(f.data || ''));
    const crc = crc32(data);
    const local = concatBytes([
      u32(0x04034b50),
      u16(20),
      u16(0x0800),
      u16(0),
      u16(0),
      u16(0),
      u32(crc),
      u32(data.length),
      u32(data.length),
      u16(nameBytes.length),
      u16(0),
      nameBytes
    ]);
    chunks.push(local, data);
    const central = concatBytes([
      u32(0x02014b50),
      u16(20),
      u16(20),
      u16(0x0800),
      u16(0),
      u16(0),
      u16(0),
      u32(crc),
      u32(data.length),
      u32(data.length),
      u16(nameBytes.length),
      u16(0),
      u16(0),
      u16(0),
      u16(0),
      u32(0),
      u32(offset),
      nameBytes
    ]);
    centrals.push(central);
    offset += local.length + data.length;
  }
  const centralStart = offset;
  for (const c of centrals) {
    chunks.push(c);
    offset += c.length;
  }
  const eocd = concatBytes([
    u32(0x06054b50),
    u16(0),
    u16(0),
    u16(files.length),
    u16(files.length),
    u32(offset - centralStart),
    u32(centralStart),
    u16(0)
  ]);
  chunks.push(eocd);
  return concatBytes(chunks);
}

function xmlEscape(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function textFromHtml(html) {
  return String(html || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|li|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

function headingFromHtml(html) {
  const m = /<h[12][^>]*>([\s\S]*?)<\/h[12]>/i.exec(String(html || ''));
  return m ? textFromHtml(m[1]).trim() : '';
}

function pngSize(bytes) {
  return imagePixelSize(bytes);
}

function imageExt(mime) {
  const m = String(mime || '').toLowerCase();
  if (m.includes('jpeg') || m.includes('jpg')) return 'jpeg';
  if (m.includes('gif')) return 'gif';
  if (m.includes('webp')) return 'webp';
  return 'png';
}

const NS_P = 'http://schemas.openxmlformats.org/presentationml/2006/main';
const NS_A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const NS_R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

function fillXml(hex) {
  const h = String(hex || '').replace('#', '');
  if (!h) return '';
  return `<a:solidFill><a:srgbClr val="${h}"/></a:solidFill>`;
}

function txBody(text, sizePt = 18, bold = false, colorHex = '') {
  const lines = String(text || ' ')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const fill = fillXml(colorHex);
  const paras =
    (lines.length ? lines : [' '])
      .map(
        (line) =>
          `<a:p><a:r><a:rPr lang="zh-CN" sz="${sizePt * 100}"${bold ? ' b="1"' : ''} dirty="0">${fill}</a:rPr><a:t>${xmlEscape(line)}</a:t></a:r></a:p>`
      )
      .join('') + '<a:p/>';
  return `<p:txBody><a:bodyPr/><a:lstStyle/>${paras}</p:txBody>`;
}

function themeInk(theme) {
  const bg = theme?.bg || '';
  const text = theme?.text || (bg && isDarkHex(bg) ? 'F8FAFC' : '');
  const accent = theme?.accent || '';
  return { bg, text, accent };
}

function bodyFromPlate(plate) {
  if (plate?.text) return String(plate.text);
  const flow = htmlRichFlow(plate?.html);
  const lines = [];
  let skippedTitle = false;
  for (const n of flow) {
    if (n.type === 'img') continue;
    if (!skippedTitle && n.type === 'h') {
      skippedTitle = true;
      continue;
    }
    if (n.text) lines.push(n.type === 'li' ? `• ${n.text}` : n.text);
  }
  return lines.join('\n');
}

function spTreeTitleBody(title, body, ink = {}) {
  return `<p:spTree>
<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>
<p:sp>
  <p:nvSpPr><p:cNvPr id="2" name="Title"/><p:cNvSpPr txBox="1"/><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr>
  <p:spPr><a:xfrm><a:off x="457200" y="274638"/><a:ext cx="8229600" cy="1143000"/></a:xfrm>
    <a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>
  ${txBody(title || ' ', 32, true, ink.accent || ink.text)}
</p:sp>
<p:sp>
  <p:nvSpPr><p:cNvPr id="3" name="Content"/><p:cNvSpPr txBox="1"/><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr>
  <p:spPr><a:xfrm><a:off x="457200" y="1600200"/><a:ext cx="8229600" cy="4525963"/></a:xfrm>
    <a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>
  ${txBody(body || ' ', 18, false, ink.text)}
</p:sp>
</p:spTree>`;
}

function picNode(id, relId, x, y, cx, cy) {
  return `<p:pic>
  <p:nvPicPr>
    <p:cNvPr id="${id}" name="Picture ${id}"/><p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr/>
  </p:nvPicPr>
  <p:blipFill><a:blip r:embed="${relId}"/><a:stretch><a:fillRect/></a:stretch></p:blipFill>
  <p:spPr><a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>
    <a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>
</p:pic>`;
}

function spTreeImage(title, relId, cx, cy, ink = {}) {
  const offX = Math.max(0, Math.floor((9144000 - cx) / 2));
  const offY = 1371600;
  return `<p:spTree>
<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>
<p:sp>
  <p:nvSpPr><p:cNvPr id="2" name="Title"/><p:cNvSpPr txBox="1"/><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr>
  <p:spPr><a:xfrm><a:off x="457200" y="137160"/><a:ext cx="8229600" cy="1005840"/></a:xfrm>
    <a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>
  ${txBody(title || ' ', 24, true, ink.accent || ink.text)}
</p:sp>
<p:pic>
  <p:nvPicPr>
    <p:cNvPr id="4" name="Picture"/><p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr/>
  </p:nvPicPr>
  <p:blipFill><a:blip r:embed="${relId}"/><a:stretch><a:fillRect/></a:stretch></p:blipFill>
  <p:spPr><a:xfrm><a:off x="${offX}" y="${offY}"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>
    <a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>
</p:pic>
</p:spTree>`;
}

function fitBox(w, h, maxW, maxH) {
  const ratio = Math.min(maxW / Math.max(w, 1), maxH / Math.max(h, 1), 1);
  return {
    cx: Math.max(457200, Math.floor(w * ratio)),
    cy: Math.max(457200, Math.floor(h * ratio))
  };
}

/**
 * Title + one or more pictures + caption. Used for HTML poster plates.
 * @param {string} title
 * @param {string} body
 * @param {Array<{ relId: string, w: number, h: number }>} pics
 */
function spTreeTitleImagesBody(title, body, pics, ink = {}) {
  const list = Array.isArray(pics) ? pics : [];
  const n = Math.max(list.length, 1);
  const gap = 114300;
  const areaX = 457200;
  const areaW = 8229600;
  const imgY = list.length === 1 ? 1050000 : 1200000;
  const imgH = list.length === 1 ? 4300000 : list.length ? 3200000 : 0;
  const cellW = Math.floor((areaW - gap * (n - 1)) / n);
  const picXml = list
    .map((pic, i) => {
      const box = fitBox((pic.w || 1) * 9525, (pic.h || 1) * 9525, cellW, imgH);
      const x = areaX + i * (cellW + gap) + Math.floor((cellW - box.cx) / 2);
      const y = imgY + Math.floor((imgH - box.cy) / 2);
      return picNode(10 + i, pic.relId, x, y, box.cx, box.cy);
    })
    .join('\n');
  const bodyY = list.length === 1 ? 5450000 : list.length ? 4600000 : 1600200;
  const bodyH = list.length === 1 ? 1100000 : list.length ? 1600000 : 4525963;
  return `<p:spTree>
<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>
<p:sp>
  <p:nvSpPr><p:cNvPr id="2" name="Title"/><p:cNvSpPr txBox="1"/><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr>
  <p:spPr><a:xfrm><a:off x="457200" y="137160"/><a:ext cx="8229600" cy="960000"/></a:xfrm>
    <a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>
  ${txBody(title || ' ', 24, true, ink.accent || ink.text)}
</p:sp>
${picXml}
<p:sp>
  <p:nvSpPr><p:cNvPr id="3" name="Content"/><p:cNvSpPr txBox="1"/><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr>
  <p:spPr><a:xfrm><a:off x="457200" y="${bodyY}"/><a:ext cx="8229600" cy="${bodyH}"/></a:xfrm>
    <a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>
  ${txBody(body || ' ', 16, false, ink.text)}
</p:sp>
</p:spTree>`;
}

function tableGrid(cols, total = 8229600) {
  const w = Math.floor(total / Math.max(cols, 1));
  return Array.from({ length: cols }, () => `<a:gridCol w="${w}"/>`).join('');
}

function spTreeTable(title, rows) {
  const table = Array.isArray(rows) && rows.length ? rows : [['']];
  const cols = Math.max(...table.map((r) => r.length), 1);
  const grid = tableGrid(cols);
  const trs = table
    .map((row, ri) => {
      const cells = [];
      for (let c = 0; c < cols; c++) {
        const val = xmlEscape(row[c] == null ? '' : String(row[c]));
        const fill = ri === 0 ? '<a:solidFill><a:srgbClr val="F43F8C"/></a:solidFill>' : '';
        cells.push(`<a:tc>
          <a:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="zh-CN" sz="1400"${ri === 0 ? ' b="1"' : ''}/><a:t>${val}</a:t></a:r></a:p></a:txBody>
          <a:tcPr>${fill}</a:tcPr>
        </a:tc>`);
      }
      return `<a:tr h="370840">${cells.join('')}</a:tr>`;
    })
    .join('');
  return `<p:spTree>
<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>
<p:sp>
  <p:nvSpPr><p:cNvPr id="2" name="Title"/><p:cNvSpPr txBox="1"/><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr>
  <p:spPr><a:xfrm><a:off x="457200" y="137160"/><a:ext cx="8229600" cy="822960"/></a:xfrm>
    <a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>
  ${txBody(title || 'Table', 24, true)}
</p:sp>
<p:graphicFrame>
  <p:nvGraphicFramePr><p:cNvPr id="5" name="Table"/><p:cNvGraphicFramePr><a:graphicFrameLocks noGrp="1"/></p:cNvGraphicFramePr><p:nvPr/></p:nvGraphicFramePr>
  <p:xfrm><a:off x="457200" y="1143000"/><a:ext cx="8229600" cy="5029200"/></p:xfrm>
  <a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table">
    <a:tbl>
      <a:tblPr/><a:tblGrid>${grid}</a:tblGrid>
      ${trs}
    </a:tbl>
  </a:graphicData></a:graphic>
</p:graphicFrame>
</p:spTree>`;
}

function slideXml(tree, bgHex = '') {
  const bg = bgHex
    ? `<p:bg><p:bgPr><a:solidFill><a:srgbClr val="${bgHex}"/></a:solidFill><a:effectLst/></p:bgPr></p:bg>`
    : '';
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="${NS_A}" xmlns:r="${NS_R}" xmlns:p="${NS_P}">
<p:cSld>${bg}${tree}</p:cSld>
<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>
</p:sld>`;
}

function themeXml() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<a:theme xmlns:a="${NS_A}" name="Browser Kitten">
<a:themeElements>
<a:clrScheme name="Office"><a:dk1><a:srgbClr val="121214"/></a:dk1><a:lt1><a:srgbClr val="FFFFFF"/></a:lt1>
<a:dk2><a:srgbClr val="1A1A1F"/></a:dk2><a:lt2><a:srgbClr val="F5F2F4"/></a:lt2>
<a:accent1><a:srgbClr val="F43F8C"/></a:accent1><a:accent2><a:srgbClr val="E879F9"/></a:accent2>
<a:accent3><a:srgbClr val="34D399"/></a:accent3><a:accent4><a:srgbClr val="FBBF24"/></a:accent4>
<a:accent5><a:srgbClr val="A78BFA"/></a:accent5><a:accent6><a:srgbClr val="FB7185"/></a:accent6>
<a:hlink><a:srgbClr val="F43F8C"/></a:hlink><a:folHlink><a:srgbClr val="E11D74"/></a:folHlink></a:clrScheme>
<a:fontScheme name="Office"><a:majorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont>
<a:minorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme>
<a:fmtScheme name="Office"><a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst>
<a:lnStyleLst><a:ln w="12700" cap="flat"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/></a:ln>
<a:ln w="12700" cap="flat"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/></a:ln>
<a:ln w="12700" cap="flat"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/></a:ln></a:lnStyleLst>
<a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst>
<a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst>
</a:fmtScheme>
</a:themeElements>
</a:theme>`;
}

function slideMasterXml() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldMaster xmlns:a="${NS_A}" xmlns:r="${NS_R}" xmlns:p="${NS_P}">
<p:cSld>
<p:bg><p:bgPr><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill><a:effectLst/></p:bgPr></p:bg>
<p:spTree>
<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>
</p:spTree>
</p:cSld>
<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>
<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst>
</p:sldMaster>`;
}

function slideLayoutXml() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldLayout xmlns:a="${NS_A}" xmlns:r="${NS_R}" xmlns:p="${NS_P}" type="titleAndContent" preserve="1">
<p:cSld name="Title and Content">
<p:spTree>
<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>
</p:spTree>
</p:cSld>
<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>
</p:sldLayout>`;
}

function presentationXml(slideCount) {
  const ids = Array.from(
    { length: slideCount },
    (_, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 2}"/>`
  ).join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:presentation xmlns:a="${NS_A}" xmlns:r="${NS_R}" xmlns:p="${NS_P}" saveSubsetFonts="1">
<p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>
<p:sldIdLst>${ids}</p:sldIdLst>
<p:sldSz cx="9144000" cy="6858000" type="screen16x9"/>
<p:notesSz cx="6858000" cy="9144000"/>
</p:presentation>`;
}

function relsXml(rels) {
  const body = rels
    .map(
      (r) =>
        `<Relationship Id="${r.id}" Type="${r.type}" Target="${r.target}"${r.mode ? ` TargetMode="${r.mode}"` : ''}/>`
    )
    .join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${body}</Relationships>`;
}

function coreXml(title) {
  const now = new Date().toISOString();
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
<dc:title>${xmlEscape(title)}</dc:title>
<dc:creator>Browser Kitten</dc:creator>
<cp:lastModifiedBy>Browser Kitten</cp:lastModifiedBy>
<dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created>
<dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified>
</cp:coreProperties>`;
}

function appXml(slides) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">
<Application>Browser Kitten</Application>
<Slides>${slides}</Slides>
</Properties>`;
}

function plateKind(p) {
  if (p?.kind) return p.kind;
  if (p?.imageBytes && p.imageBytes.byteLength) return 'image';
  if (Array.isArray(p?.table) && p.table.length) return 'table';
  if (p?.fileName) return 'file';
  return 'html';
}

/**
 * @param {Array<object>} plates
 * @param {{ title?: string }} [opts]
 * @returns {Uint8Array}
 */
export function platesToPptxBytes(plates, opts = {}) {
  const list = Array.isArray(plates) && plates.length ? plates : [{ html: '<p></p>', title: 'Slide' }];
  const title = opts.title || 'Browser Kitten';
  const ink = themeInk(opts.theme || {});
  const files = [];
  const mediaOverrides = [];
  const slideRelsForPres = [];

  list.forEach((plate, i) => {
    const n = i + 1;
    const kind = plateKind(plate);
    let tree;
    /** @type {Array<{id:string,type:string,target:string}>} */
    const slideRels = [
      {
        id: 'rId1',
        type: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout',
        target: '../slideLayouts/slideLayout1.xml'
      }
    ];
    const inline = Array.isArray(plate.inlineImages)
      ? plate.inlineImages.filter((im) => im?.bytes?.byteLength)
      : [];
    if (kind === 'image' && plate.imageBytes && plate.imageBytes.byteLength && !inline.length) {
      const ext = imageExt(plate.imageMime);
      const mediaName = `ppt/media/image${n}.${ext}`;
      files.push({ name: mediaName, data: plate.imageBytes });
      const ct =
        ext === 'jpeg'
          ? 'image/jpeg'
          : ext === 'gif'
            ? 'image/gif'
            : ext === 'webp'
              ? 'image/webp'
              : 'image/png';
      mediaOverrides.push(
        `<Default Extension="${ext}" ContentType="${ct}"/>`
      );
      slideRels.push({
        id: 'rId2',
        type: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/image',
        target: `../media/image${n}.${ext}`
      });
      const { w, h } = pngSize(plate.imageBytes);
      const maxW = 8229600;
      const maxH = 4800600;
      const ratio = Math.min(maxW / (w * 9525), maxH / (h * 9525), 1);
      const cx = Math.max(914400, Math.floor(w * 9525 * ratio));
      const cy = Math.max(914400, Math.floor(h * 9525 * ratio));
      tree = spTreeImage(plate.title || `Image ${n}`, 'rId2', cx, cy, ink);
    } else if (kind === 'table') {
      tree = spTreeTable(plate.title || 'Table', plate.table);
    } else {
      const h = plate.title || headingFromHtml(plate.html) || `Slide ${n}`;
      const body = bodyFromPlate(plate) || ' ';
      tree = spTreeTitleBody(h, body, ink);
    }
    if (inline.length) {
      const pics = [];
      inline.forEach((im, j) => {
        const ext = imageExt(im.mime);
        const mediaName = `ppt/media/image${n}_${j + 1}.${ext}`;
        files.push({ name: mediaName, data: im.bytes });
        const ct =
          ext === 'jpeg'
            ? 'image/jpeg'
            : ext === 'gif'
              ? 'image/gif'
              : ext === 'webp'
                ? 'image/webp'
                : 'image/png';
        mediaOverrides.push(`<Default Extension="${ext}" ContentType="${ct}"/>`);
        const rid = `rId${slideRels.length + 1}`;
        slideRels.push({
          id: rid,
          type: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/image',
          target: `../media/image${n}_${j + 1}.${ext}`
        });
        const { w, h: ih } = pngSize(im.bytes);
        pics.push({ relId: rid, w, h: ih });
      });
      const h = plate.title || headingFromHtml(plate.html) || `Slide ${n}`;
      const body = bodyFromPlate(plate) || ' ';
      tree = spTreeTitleImagesBody(h, body, pics, ink);
    }
    files.push({ name: `ppt/slides/slide${n}.xml`, data: slideXml(tree, ink.bg) });
    files.push({
      name: `ppt/slides/_rels/slide${n}.xml.rels`,
      data: relsXml(slideRels)
    });
    slideRelsForPres.push(`rId${n + 1}`);
  });

  const presRels = [
    {
      id: 'rId1',
      type: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster',
      target: 'slideMasters/slideMaster1.xml'
    },
    ...list.map((_, i) => ({
      id: `rId${i + 2}`,
      type: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide',
      target: `slides/slide${i + 1}.xml`
    }))
  ];

  const slideOverrides = list
    .map(
      (_, i) =>
        `<Override PartName="/ppt/slides/slide${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`
    )
    .join('');

  const uniqueMedia = [...new Set(mediaOverrides)];
  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
${uniqueMedia.join('\n')}
<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>
<Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>
<Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>
<Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>
<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
${slideOverrides}
</Types>`;

  files.push(
    { name: '[Content_Types].xml', data: contentTypes },
    {
      name: '_rels/.rels',
      data: relsXml([
        {
          id: 'rId1',
          type: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument',
          target: 'ppt/presentation.xml'
        },
        {
          id: 'rId2',
          type: 'http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties',
          target: 'docProps/core.xml'
        },
        {
          id: 'rId3',
          type: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties',
          target: 'docProps/app.xml'
        }
      ])
    },
    { name: 'ppt/presentation.xml', data: presentationXml(list.length) },
    { name: 'ppt/_rels/presentation.xml.rels', data: relsXml(presRels) },
    { name: 'ppt/slideMasters/slideMaster1.xml', data: slideMasterXml() },
    {
      name: 'ppt/slideMasters/_rels/slideMaster1.xml.rels',
      data: relsXml([
        {
          id: 'rId1',
          type: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout',
          target: '../slideLayouts/slideLayout1.xml'
        },
        {
          id: 'rId2',
          type: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme',
          target: '../theme/theme1.xml'
        }
      ])
    },
    { name: 'ppt/slideLayouts/slideLayout1.xml', data: slideLayoutXml() },
    {
      name: 'ppt/slideLayouts/_rels/slideLayout1.xml.rels',
      data: relsXml([
        {
          id: 'rId1',
          type: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster',
          target: '../slideMasters/slideMaster1.xml'
        }
      ])
    },
    { name: 'ppt/theme/theme1.xml', data: themeXml() },
    { name: 'docProps/core.xml', data: coreXml(title) },
    { name: 'docProps/app.xml', data: appXml(list.length) }
  );

  return buildZipStore(files);
}

export const PPTX_CONTENT_TYPE = PPTX_MIME;
