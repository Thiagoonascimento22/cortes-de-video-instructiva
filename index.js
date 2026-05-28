// ============================================================
//  CORTADOR - serviço isolado (NÃO mexe na Clara)
//  Serve a página em "/" e corta o video em "/cortar"
// ============================================================

const express = require('express');
const cors = require('cors');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const zlib = require('zlib');

const app = express();
app.use(cors());
app.use(express.json());

const YTDLP = path.join(os.tmpdir(), 'yt-dlp_bin');
const YTDLP_URL = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux';
const MAX_SEGUNDOS = 15 * 60;

// Cookies do YouTube (vêm da variável privada YOUTUBE_COOKIES do Railway)
const COOKIES_PATH = path.join(os.tmpdir(), 'yt-cookies.txt');
let cookiesOk = false;
function prepararCookies() {
  const raw = process.env.YOUTUBE_COOKIES;
  if (!raw || !raw.trim()) { cookiesOk = false; return; }
  let conteudo = raw.replace(/\r\n/g, '\n').trim();

  // Detecta se veio em base64 (uma linha so, sem tabs) e decodifica
  if (!conteudo.includes('\t') && !conteudo.startsWith('# Netscape') && /^[A-Za-z0-9+/=\s]+$/.test(conteudo)) {
    try {
      const decoded = Buffer.from(conteudo.replace(/\s+/g, ''), 'base64').toString('utf8');
      if (decoded.includes('\t') || decoded.startsWith('# Netscape')) {
        conteudo = decoded;
        console.log('[cortador] cookies vieram em base64, decodificados');
      }
    } catch (e) {}
  }

  if (!conteudo.startsWith('# Netscape')) conteudo = '# Netscape HTTP Cookie File\n' + conteudo;
  try {
    fs.writeFileSync(COOKIES_PATH, conteudo);
    cookiesOk = true;
    const linhas = conteudo.split('\n').filter(l => l && !l.startsWith('#'));
    const comTabs = linhas.filter(l => l.includes('\t')).length;
    console.log(`[cortador] cookies: ${linhas.length} linhas, ${comTabs} com tabs`);
  } catch (e) { cookiesOk = false; }
}
prepararCookies();
console.log('[cortador] cookies:', cookiesOk ? 'carregados' : 'ausentes');

// Proxy (opcional) - 4 variaveis separadas pra evitar dor com URL-encoding
// PROXY_HOST, PROXY_PORT, PROXY_USER, PROXY_PASS
let PROXY_URL = null;
(function montarProxy() {
  const h = (process.env.PROXY_HOST || '').trim();
  const p = (process.env.PROXY_PORT || '').trim();
  const u = (process.env.PROXY_USER || '').trim();
  const s = (process.env.PROXY_PASS || '').trim();
  if (!h || !p) return;
  if (u && s) {
    PROXY_URL = `http://${encodeURIComponent(u)}:${encodeURIComponent(s)}@${h}:${p}`;
  } else {
    PROXY_URL = `http://${h}:${p}`;
  }
})();
console.log('[cortador] proxy:', PROXY_URL ? `configurado (${process.env.PROXY_HOST}:${process.env.PROXY_PORT})` : 'sem proxy');

// A pagina do cortador (embutida)
const PAGINA = Buffer.from("PCFkb2N0eXBlIGh0bWw+CjxodG1sIGxhbmc9InB0LUJSIj4KPGhlYWQ+CjxtZXRhIGNoYXJzZXQ9InV0Zi04Ij4KPG1ldGEgbmFtZT0idmlld3BvcnQiIGNvbnRlbnQ9IndpZHRoPWRldmljZS13aWR0aCwgaW5pdGlhbC1zY2FsZT0xIj4KPHRpdGxlPkNvcnRhZG9yIMK3IEluc3RydWN0aXZhPC90aXRsZT4KPGxpbmsgcmVsPSJwcmVjb25uZWN0IiBocmVmPSJodHRwczovL2ZvbnRzLmdvb2dsZWFwaXMuY29tIj4KPGxpbmsgcmVsPSJwcmVjb25uZWN0IiBocmVmPSJodHRwczovL2ZvbnRzLmdzdGF0aWMuY29tIiBjcm9zc29yaWdpbj4KPGxpbmsgaHJlZj0iaHR0cHM6Ly9mb250cy5nb29nbGVhcGlzLmNvbS9jc3MyP2ZhbWlseT1Ccmljb2xhZ2UrR3JvdGVzcXVlOm9wc3osd2dodEAxMi4uOTYsNDAwOzEyLi45Niw2MDA7MTIuLjk2LDgwMCZmYW1pbHk9SGFua2VuK0dyb3Rlc2s6d2dodEA0MDA7NTAwOzYwMDs3MDAmZGlzcGxheT1zd2FwIiByZWw9InN0eWxlc2hlZXQiPgo8c3R5bGU+CiAgOnJvb3R7CiAgICAtLWJnOiMwZDBlMTI7IC0tYmcyOiMxNDE1MWI7IC0tcGFuZWw6IzE3MTkyMjsgLS1wYW5lbDI6IzFkMjAyOTsKICAgIC0tbGluZTojMjYyYTM2OyAtLWluazojZWVmMGY1OyAtLW11dGVkOiM5YWEwYjA7IC0tZmFpbnQ6IzY0NmI3ZDsKICAgIC0tYWNjZW50OiNmZjU0MzY7IC0tYWNjZW50MjojZmZiMDNhOyAtLWdvb2Q6IzNkZGM4NDsgLS1sb3c6I2ZmNmE1YTsKICB9CiAgKntib3gtc2l6aW5nOmJvcmRlci1ib3h9CiAgYm9keXsKICAgIG1hcmdpbjowO2ZvbnQtZmFtaWx5OidIYW5rZW4gR3JvdGVzaycsc3lzdGVtLXVpLHNhbnMtc2VyaWY7Y29sb3I6dmFyKC0taW5rKTttaW4taGVpZ2h0OjEwMHZoO2xpbmUtaGVpZ2h0OjEuNTsKICAgIGJhY2tncm91bmQ6cmFkaWFsLWdyYWRpZW50KDExMDBweCA2MDBweCBhdCA4MCUgLTEwJSxyZ2JhKDI1NSw4NCw1NCwuMTIpLHRyYW5zcGFyZW50IDYwJSkscmFkaWFsLWdyYWRpZW50KDkwMHB4IDUwMHB4IGF0IDAlIDAlLHJnYmEoMjU1LDE3Niw1OCwuMDgpLHRyYW5zcGFyZW50IDU1JSksdmFyKC0tYmcpOwogICAgLXdlYmtpdC1mb250LXNtb290aGluZzphbnRpYWxpYXNlZDsKICB9CiAgLndyYXB7bWF4LXdpZHRoOjYyMHB4O21hcmdpbjowIGF1dG87cGFkZGluZzo0MHB4IDIwcHggODBweH0KICBoZWFkZXJ7ZGlzcGxheTpmbGV4O2FsaWduLWl0ZW1zOmNlbnRlcjtnYXA6MTRweDttYXJnaW4tYm90dG9tOjhweH0KICAubG9nb3t3aWR0aDo0NnB4O2hlaWdodDo0NnB4O2JvcmRlci1yYWRpdXM6MTRweDtiYWNrZ3JvdW5kOmxpbmVhci1ncmFkaWVudCgxMzVkZWcsdmFyKC0tYWNjZW50KSx2YXIoLS1hY2NlbnQyKSk7ZGlzcGxheTpncmlkO3BsYWNlLWl0ZW1zOmNlbnRlcjtib3gtc2hhZG93OjAgOHB4IDMwcHggcmdiYSgyNTUsODQsNTQsLjM1KX0KICBoMXtmb250LWZhbWlseTonQnJpY29sYWdlIEdyb3Rlc3F1ZScsc2Fucy1zZXJpZjtmb250LXdlaWdodDo4MDA7Zm9udC1zaXplOjMwcHg7bWFyZ2luOjA7bGV0dGVyLXNwYWNpbmc6LS4wMmVtfQogIC5zdWJ7Y29sb3I6dmFyKC0tbXV0ZWQpO2ZvbnQtc2l6ZToxNHB4O21hcmdpbjoycHggMCAwfQogIC5jYXJke2JhY2tncm91bmQ6bGluZWFyLWdyYWRpZW50KDE4MGRlZyx2YXIoLS1wYW5lbCksdmFyKC0tYmcyKSk7Ym9yZGVyOjFweCBzb2xpZCB2YXIoLS1saW5lKTtib3JkZXItcmFkaXVzOjE2cHg7cGFkZGluZzoyNHB4O21hcmdpbi10b3A6MjZweH0KICBsYWJlbHtkaXNwbGF5OmJsb2NrO2ZvbnQtc2l6ZToxMi41cHg7Zm9udC13ZWlnaHQ6NjAwO2NvbG9yOnZhcigtLW11dGVkKTttYXJnaW46MCAwIDdweDt0ZXh0LXRyYW5zZm9ybTp1cHBlcmNhc2U7bGV0dGVyLXNwYWNpbmc6LjA0ZW19CiAgaW5wdXR7d2lkdGg6MTAwJTtiYWNrZ3JvdW5kOnZhcigtLWJnKTtib3JkZXI6MXB4IHNvbGlkIHZhcigtLWxpbmUpO2JvcmRlci1yYWRpdXM6MTJweDtjb2xvcjp2YXIoLS1pbmspO2ZvbnQtZmFtaWx5OmluaGVyaXQ7Zm9udC1zaXplOjE1cHg7cGFkZGluZzoxM3B4IDE0cHg7b3V0bGluZTpub25lfQogIGlucHV0OmZvY3Vze2JvcmRlci1jb2xvcjp2YXIoLS1hY2NlbnQpfQogIC50aW1lc3tkaXNwbGF5OmZsZXg7Z2FwOjE0cHg7bWFyZ2luLXRvcDoxOHB4fQogIC50aW1lcyA+IGRpdntmbGV4OjF9CiAgLmJ0bnttYXJnaW4tdG9wOjIycHg7d2lkdGg6MTAwJTtib3JkZXI6bm9uZTtjdXJzb3I6cG9pbnRlcjtmb250LWZhbWlseTonQnJpY29sYWdlIEdyb3Rlc3F1ZScsc2Fucy1zZXJpZjtmb250LXdlaWdodDo3MDA7Zm9udC1zaXplOjE2cHg7Y29sb3I6IzFhMGQwOTtiYWNrZ3JvdW5kOmxpbmVhci1ncmFkaWVudCgxMzVkZWcsdmFyKC0tYWNjZW50KSx2YXIoLS1hY2NlbnQyKSk7cGFkZGluZzoxNXB4O2JvcmRlci1yYWRpdXM6MTJweDt0cmFuc2l0aW9uOnRyYW5zZm9ybSAuMTJzLGJveC1zaGFkb3cgLjEycztib3gtc2hhZG93OjAgOHB4IDI0cHggcmdiYSgyNTUsODQsNTQsLjMpO2Rpc3BsYXk6ZmxleDthbGlnbi1pdGVtczpjZW50ZXI7anVzdGlmeS1jb250ZW50OmNlbnRlcjtnYXA6OXB4fQogIC5idG46aG92ZXJ7dHJhbnNmb3JtOnRyYW5zbGF0ZVkoLTFweCk7Ym94LXNoYWRvdzowIDEycHggMzBweCByZ2JhKDI1NSw4NCw1NCwuNDIpfQogIC5idG46ZGlzYWJsZWR7b3BhY2l0eTouNTtjdXJzb3I6bm90LWFsbG93ZWQ7dHJhbnNmb3JtOm5vbmV9CiAgLmhpbnR7Zm9udC1zaXplOjEzcHg7Y29sb3I6dmFyKC0tZmFpbnQpO21hcmdpbi10b3A6MTRweDtsaW5lLWhlaWdodDoxLjZ9CiAgLnN0YXR1c3ttYXJnaW4tdG9wOjIycHg7dGV4dC1hbGlnbjpjZW50ZXI7Zm9udC1zaXplOjE0LjVweDtjb2xvcjp2YXIoLS1tdXRlZCl9CiAgLnNwaW5uZXJ7ZGlzcGxheTppbmxpbmUtYmxvY2s7d2lkdGg6MTZweDtoZWlnaHQ6MTZweDtib3JkZXI6MnB4IHNvbGlkIHZhcigtLWxpbmUpO2JvcmRlci10b3AtY29sb3I6dmFyKC0tYWNjZW50KTtib3JkZXItcmFkaXVzOjUwJTthbmltYXRpb246c3BpbiAuOHMgbGluZWFyIGluZmluaXRlO3ZlcnRpY2FsLWFsaWduOi0zcHg7bWFyZ2luLXJpZ2h0OjhweH0KICBAa2V5ZnJhbWVzIHNwaW57dG97dHJhbnNmb3JtOnJvdGF0ZSgzNjBkZWcpfX0KICAuZXJye21hcmdpbi10b3A6MjBweDtiYWNrZ3JvdW5kOnJnYmEoMjU1LDEwNiw5MCwuMSk7Ym9yZGVyOjFweCBzb2xpZCByZ2JhKDI1NSwxMDYsOTAsLjQpO2NvbG9yOiNmZmIzYWE7cGFkZGluZzoxNHB4IDE2cHg7Ym9yZGVyLXJhZGl1czoxMnB4O2ZvbnQtc2l6ZToxNHB4fQogIC5va3ttYXJnaW4tdG9wOjIycHg7YmFja2dyb3VuZDpyZ2JhKDYxLDIyMCwxMzIsLjA4KTtib3JkZXI6MXB4IHNvbGlkIHJnYmEoNjEsMjIwLDEzMiwuMzUpO2JvcmRlci1yYWRpdXM6MTRweDtwYWRkaW5nOjIwcHg7dGV4dC1hbGlnbjpjZW50ZXJ9CiAgLm9rIHB7bWFyZ2luOjAgMCAxNHB4O2NvbG9yOnZhcigtLWdvb2QpO2ZvbnQtd2VpZ2h0OjYwMH0KICAub2sgYXtkaXNwbGF5OmlubGluZS1ibG9jaztiYWNrZ3JvdW5kOnZhcigtLWdvb2QpO2NvbG9yOiMwNjIwMTM7Zm9udC13ZWlnaHQ6NzAwO2ZvbnQtZmFtaWx5OidCcmljb2xhZ2UgR3JvdGVzcXVlJyxzYW5zLXNlcmlmO3RleHQtZGVjb3JhdGlvbjpub25lO3BhZGRpbmc6MTJweCAyMnB4O2JvcmRlci1yYWRpdXM6MTFweH0KICBmb290ZXJ7bWFyZ2luLXRvcDo0MHB4O3RleHQtYWxpZ246Y2VudGVyO2NvbG9yOnZhcigtLWZhaW50KTtmb250LXNpemU6MTJweH0KPC9zdHlsZT4KPC9oZWFkPgo8Ym9keT4KPGRpdiBjbGFzcz0id3JhcCI+CiAgPGhlYWRlcj4KICAgIDxkaXYgY2xhc3M9ImxvZ28iPgogICAgICA8c3ZnIHdpZHRoPSIyNCIgaGVpZ2h0PSIyNCIgdmlld0JveD0iMCAwIDI0IDI0IiBmaWxsPSJub25lIiBzdHJva2U9IiMxYTBkMDkiIHN0cm9rZS13aWR0aD0iMi4yIiBzdHJva2UtbGluZWNhcD0icm91bmQiIHN0cm9rZS1saW5lam9pbj0icm91bmQiPjxjaXJjbGUgY3g9IjYiIGN5PSI2IiByPSIzIi8+PGNpcmNsZSBjeD0iNiIgY3k9IjE4IiByPSIzIi8+PGxpbmUgeDE9IjIwIiB5MT0iNCIgeDI9IjguMTIiIHkyPSIxNS44OCIvPjxsaW5lIHgxPSIxNC40NyIgeTE9IjE0LjQ4IiB4Mj0iMjAiIHkyPSIyMCIvPjxsaW5lIHgxPSI4LjEyIiB5MT0iOC4xMiIgeDI9IjEyIiB5Mj0iMTIiLz48L3N2Zz4KICAgIDwvZGl2PgogICAgPGRpdj48aDE+Q29ydGFkb3I8L2gxPjxwIGNsYXNzPSJzdWIiPkNvbGEgbyBsaW5rLCBlc2NvbGhlIG8gdHJlY2hvLCBiYWl4YSBvIGNvcnRlLjwvcD48L2Rpdj4KICA8L2hlYWRlcj4KCiAgPGRpdiBjbGFzcz0iY2FyZCI+CiAgICA8bGFiZWwgZm9yPSJ1cmwiPkxpbmsgZG8gdsOtZGVvIG5vIFlvdVR1YmU8L2xhYmVsPgogICAgPGlucHV0IGlkPSJ1cmwiIHR5cGU9InRleHQiIHBsYWNlaG9sZGVyPSJodHRwczovL3lvdXR1YmUuY29tL3dhdGNoP3Y9Li4uIj4KICAgIDxkaXYgY2xhc3M9InRpbWVzIj4KICAgICAgPGRpdj48bGFiZWwgZm9yPSJpbmkiPkRvIG1pbnV0bzwvbGFiZWw+PGlucHV0IGlkPSJpbmkiIHR5cGU9InRleHQiIHBsYWNlaG9sZGVyPSI0OjMyIj48L2Rpdj4KICAgICAgPGRpdj48bGFiZWwgZm9yPSJmaW0iPkF0w6kgbyBtaW51dG88L2xhYmVsPjxpbnB1dCBpZD0iZmltIiB0eXBlPSJ0ZXh0IiBwbGFjZWhvbGRlcj0iNjoxMCI+PC9kaXY+CiAgICA8L2Rpdj4KICAgIDxidXR0b24gY2xhc3M9ImJ0biIgaWQ9ImdvIiBvbmNsaWNrPSJjb3J0YXIoKSI+CiAgICAgIDxzdmcgd2lkdGg9IjE4IiBoZWlnaHQ9IjE4IiB2aWV3Qm94PSIwIDAgMjQgMjQiIGZpbGw9Im5vbmUiIHN0cm9rZT0iIzFhMGQwOSIgc3Ryb2tlLXdpZHRoPSIyLjQiIHN0cm9rZS1saW5lY2FwPSJyb3VuZCIgc3Ryb2tlLWxpbmVqb2luPSJyb3VuZCI+PGNpcmNsZSBjeD0iNiIgY3k9IjYiIHI9IjMiLz48Y2lyY2xlIGN4PSI2IiBjeT0iMTgiIHI9IjMiLz48bGluZSB4MT0iMjAiIHkxPSI0IiB4Mj0iOC4xMiIgeTI9IjE1Ljg4Ii8+PGxpbmUgeDE9IjE0LjQ3IiB5MT0iMTQuNDgiIHgyPSIyMCIgeTI9IjIwIi8+PC9zdmc+CiAgICAgIENvcnRhciBlIGJhaXhhcgogICAgPC9idXR0b24+CiAgICA8cCBjbGFzcz0iaGludCI+RXNjcmV2ZSBvIHRlbXBvIGFzc2ltOiA8Yj40OjMyPC9iPiAobWludXRvIGUgc2VndW5kbykuIFNlIHBhc3NhciBkZSB1bWEgaG9yYSwgdXNhIDxiPjE6MDQ6MTA8L2I+LiBCYWl4YSBzw7MgbyB0cmVjaG8gcXVlIHZvY8OqIG1hcmNvdSwgZW50w6NvIMOpIHLDoXBpZG8uPC9wPgogIDwvZGl2PgoKICA8ZGl2IGlkPSJzdGF0dXMiPjwvZGl2PgoKICA8Zm9vdGVyPkNvcnRhZG9yIMK3IEluc3RydWN0aXZhPC9mb290ZXI+CjwvZGl2PgoKPHNjcmlwdD4KLy8g4pqg77iPIFRST1FVRSBBUVVJIHBlbGEgVVJMIGRvIHNlcnZpw6dvIENvcnRhZG9yIG5vIHNldSBSYWlsd2F5IChzZW0gYmFycmEgbm8gZmluYWwpLgovLyBFeDogY29uc3QgQVBJID0gImh0dHBzOi8vY29ydGFkb3ItcHJvZHVjdGlvbi51cC5yYWlsd2F5LmFwcCI7CmNvbnN0IEFQSSA9ICIiOwoKY29uc3QgJCA9IGlkID0+IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKGlkKTsKCmFzeW5jIGZ1bmN0aW9uIGNvcnRhcigpewogIGNvbnN0IHVybCA9ICQoJ3VybCcpLnZhbHVlLnRyaW0oKTsKICBjb25zdCBpbmljaW8gPSAkKCdpbmknKS52YWx1ZS50cmltKCk7CiAgY29uc3QgZmltID0gJCgnZmltJykudmFsdWUudHJpbSgpOwogICQoJ3N0YXR1cycpLmlubmVySFRNTCA9ICcnOwoKICBpZihBUEkuc3RhcnRzV2l0aCgnQ09MRV9BUVVJJykpeyBlcnJvKCdBIHDDoWdpbmEgYWluZGEgbsOjbyBmb2kgbGlnYWRhIGFvIHNlcnZpZG9yLiBBdmlzYSBvIFRoaWFnbyBwcmEgY29sb2NhciBhIFVSTCBkbyBSYWlsd2F5LicpOyByZXR1cm47IH0KICBpZighdXJsKXsgZXJybygnQ29sYSBvIGxpbmsgZG8gWW91VHViZS4nKTsgcmV0dXJuOyB9CiAgaWYoIWluaWNpbyB8fCAhZmltKXsgZXJybygnUHJlZW5jaGUgbyBtaW51dG8gZGUgaW7DrWNpbyBlIGRlIGZpbS4nKTsgcmV0dXJuOyB9CgogICQoJ2dvJykuZGlzYWJsZWQgPSB0cnVlOwogICQoJ3N0YXR1cycpLmlubmVySFRNTCA9ICc8ZGl2IGNsYXNzPSJzdGF0dXMiPjxzcGFuIGNsYXNzPSJzcGlubmVyIj48L3NwYW4+QmFpeGFuZG8gZSBjb3J0YW5kbyBvIHRyZWNoby4uLiAocG9kZSBsZXZhciBkZSBhbGd1bnMgc2VndW5kb3MgYSAxIG1pbnV0byk8L2Rpdj4nOwoKICB0cnl7CiAgICBjb25zdCByZXMgPSBhd2FpdCBmZXRjaChBUEkgKyAnL2NvcnRhcicsIHsKICAgICAgbWV0aG9kOidQT1NUJywKICAgICAgaGVhZGVyczp7J0NvbnRlbnQtVHlwZSc6J2FwcGxpY2F0aW9uL2pzb24nfSwKICAgICAgYm9keTogSlNPTi5zdHJpbmdpZnkoeyB1cmwsIGluaWNpbywgZmltIH0pCiAgICB9KTsKICAgIGNvbnN0IHRpcG8gPSByZXMuaGVhZGVycy5nZXQoJ2NvbnRlbnQtdHlwZScpIHx8ICcnOwogICAgaWYodGlwby5pbmNsdWRlcygnYXBwbGljYXRpb24vanNvbicpKXsKICAgICAgY29uc3QgaiA9IGF3YWl0IHJlcy5qc29uKCk7CiAgICAgIGVycm8oai5lcnJvIHx8ICdOw6NvIGNvbnNlZ3VpIGNvcnRhciBlc3NlIHbDrWRlby4nLCBqLmRldGFsaGUpOwogICAgICByZXR1cm47CiAgICB9CiAgICBjb25zdCBibG9iID0gYXdhaXQgcmVzLmJsb2IoKTsKICAgIGNvbnN0IGxpbmsgPSBVUkwuY3JlYXRlT2JqZWN0VVJMKGJsb2IpOwogICAgY29uc3Qgbm9tZSA9IGBjb3J0ZV8ke2luaWNpby5yZXBsYWNlKC86L2csJy0nKX1fYV8ke2ZpbS5yZXBsYWNlKC86L2csJy0nKX0ubXA0YDsKICAgIGNvbnN0IGEgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdhJyk7CiAgICBhLmhyZWYgPSBsaW5rOyBhLmRvd25sb2FkID0gbm9tZTsgZG9jdW1lbnQuYm9keS5hcHBlbmRDaGlsZChhKTsgYS5jbGljaygpOyBhLnJlbW92ZSgpOwogICAgJCgnc3RhdHVzJykuaW5uZXJIVE1MID0gYDxkaXYgY2xhc3M9Im9rIj48cD7inJMgQ29ydGUgcHJvbnRvISBPIGRvd25sb2FkIGNvbWXDp291LjwvcD48YSBocmVmPSIke2xpbmt9IiBkb3dubG9hZD0iJHtub21lfSI+QmFpeGFyIGRlIG5vdm88L2E+PC9kaXY+YDsKICB9Y2F0Y2goZSl7CiAgICBlcnJvKCdOw6NvIGNvbnNlZ3VpIGZhbGFyIGNvbSBvIHNlcnZpZG9yLiBDb25mZXJlIHNlIG8gUmFpbHdheSB0w6Egbm8gYXIuICgnKyBlLm1lc3NhZ2UgKycpJyk7CiAgfWZpbmFsbHl7CiAgICAkKCdnbycpLmRpc2FibGVkID0gZmFsc2U7CiAgfQp9CmZ1bmN0aW9uIGVycm8obXNnLCBkZXRhbGhlKXsKICBsZXQgaCA9ICc8ZGl2IGNsYXNzPSJlcnIiPicgKyBtc2c7CiAgaWYoZGV0YWxoZSl7IGggKz0gJzxkaXYgc3R5bGU9Im1hcmdpbi10b3A6MTBweDtmb250LXNpemU6MTEuNXB4O2NvbG9yOiNjOWEwOGU7d2hpdGUtc3BhY2U6cHJlLXdyYXA7Zm9udC1mYW1pbHk6bW9ub3NwYWNlO2xpbmUtaGVpZ2h0OjEuNSI+JyArIFN0cmluZyhkZXRhbGhlKS5yZXBsYWNlKC9bJjw+XS9nLGM9Pih7JyYnOicmYW1wOycsJzwnOicmbHQ7JywnPic6JyZndDsnfVtjXSkpICsgJzwvZGl2Pic7IH0KICBoICs9ICc8L2Rpdj4nOwogICQoJ3N0YXR1cycpLmlubmVySFRNTCA9IGg7Cn0KPC9zY3JpcHQ+CjwvYm9keT4KPC9odG1sPgo=", 'base64').toString('utf8');

let prontoYtdlp = null;
function garantirYtdlp() {
  if (prontoYtdlp) return prontoYtdlp;
  prontoYtdlp = new Promise((resolve, reject) => {
    if (fs.existsSync(YTDLP)) { try { fs.chmodSync(YTDLP, 0o755); } catch (e) {} return resolve(); }
    const baixar = (url) => {
      https.get(url, (r) => {
        if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location) return baixar(r.headers.location);
        if (r.statusCode !== 200) return reject(new Error('Nao consegui baixar o yt-dlp (' + r.statusCode + ')'));
        const arq = fs.createWriteStream(YTDLP);
        r.pipe(arq);
        arq.on('finish', () => arq.close(() => { fs.chmodSync(YTDLP, 0o755); resolve(); }));
      }).on('error', reject);
    };
    baixar(YTDLP_URL);
  });
  return prontoYtdlp;
}

// ---- Baixa o ffmpeg (vem compactado .gz, descompacta na hora) ----
const FFMPEG = path.join(os.tmpdir(), 'ffmpeg_bin');
const FFMPEG_URL = 'https://github.com/eugeneware/ffmpeg-static/releases/latest/download/ffmpeg-linux-x64.gz';
let prontoFfmpeg = null;
function garantirFfmpeg() {
  if (prontoFfmpeg) return prontoFfmpeg;
  prontoFfmpeg = new Promise((resolve, reject) => {
    if (fs.existsSync(FFMPEG)) { try { fs.chmodSync(FFMPEG, 0o755); } catch (e) {} return resolve(); }
    const baixar = (url) => {
      https.get(url, (r) => {
        if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location) return baixar(r.headers.location);
        if (r.statusCode !== 200) return reject(new Error('Não consegui baixar o ffmpeg (' + r.statusCode + ')'));
        const out = fs.createWriteStream(FFMPEG);
        r.pipe(zlib.createGunzip()).pipe(out);
        out.on('finish', () => out.close(() => { fs.chmodSync(FFMPEG, 0o755); resolve(); }));
        out.on('error', reject);
      }).on('error', reject);
    };
    baixar(FFMPEG_URL);
  });
  return prontoFfmpeg;
}

function linkValido(u) {
  return typeof u === 'string' && /^https:\/\/(www\.|m\.)?(youtube\.com\/|youtu\.be\/)/.test(u.trim());
}
function tempoValido(t) {
  return typeof t === 'string' && /^(\d{1,2}:)?\d{1,2}:\d{2}$|^\d{1,3}(:\d{2}){0,2}$|^\d+$/.test(t.trim());
}
function paraSegundos(t) {
  const p = String(t).trim().split(':').map(Number);
  if (p.some(isNaN)) return NaN;
  return p.reduce((acc, v) => acc * 60 + v, 0);
}

app.get('/', (_req, res) => res.type('html').send(PAGINA));
app.get('/status', (_req, res) => res.json({ ok: true, servico: 'cortador', versao: 12, cookies: cookiesOk, proxy: PROXY_URL ? (process.env.PROXY_HOST + ':' + process.env.PROXY_PORT) : false }));

app.post('/cortar', async (req, res) => {
  const url = (req.body.url || '').trim();
  const inicio = String(req.body.inicio || '').trim();
  const fim = String(req.body.fim || '').trim();

  if (!linkValido(url)) return res.status(400).json({ erro: 'Cole um link valido do YouTube.' });
  if (!tempoValido(inicio) || !tempoValido(fim)) return res.status(400).json({ erro: 'Use o formato de tempo certo, tipo 4:32 ou 1:04:10.' });

  const si = paraSegundos(inicio), sf = paraSegundos(fim);
  if (isNaN(si) || isNaN(sf) || sf <= si) return res.status(400).json({ erro: 'O fim precisa ser depois do inicio.' });
  if (sf - si > MAX_SEGUNDOS) return res.status(400).json({ erro: 'O corte ta muito longo (maximo 15 minutos por vez).' });

  let pasta;
  try {
    await garantirYtdlp();
    await garantirFfmpeg();
    pasta = fs.mkdtempSync(path.join(os.tmpdir(), 'corte-'));
    const secao = `*${inicio}-${fim}`;
    const args = [
      '--no-playlist', '--no-warnings', '--no-progress',
      '--extractor-args', 'youtube:player_client=tv,web_safari,default',
      ...(cookiesOk ? ['--cookies', COOKIES_PATH] : []),
      ...(PROXY_URL ? ['--proxy', PROXY_URL] : []),
      '--ffmpeg-location', FFMPEG,
      '-f', 'bv*[vcodec^=avc1][height<=720]+ba[ext=m4a]/b[ext=mp4][height<=720]/b[ext=mp4]/b',
      '--download-sections', secao,
      '--merge-output-format', 'mp4',
      '-o', path.join(pasta, 'corte.%(ext)s'),
      url,
    ];

    console.log('[cortador] rodando yt-dlp | trecho', secao, '| url', url, '| proxy:', PROXY_URL ? 'sim' : 'nao');
    const proc = spawn(YTDLP, args);
    let erroSaida = '';
    proc.stderr.on('data', d => { erroSaida += d.toString(); });
    proc.stdout.on('data', d => { erroSaida += d.toString(); });

    proc.on('close', (codigo) => {
      console.log('[cortador] yt-dlp terminou com codigo', codigo);
      if (erroSaida) console.log('[cortador] saida do yt-dlp:\n' + erroSaida.slice(-1500));
      if (codigo !== 0) {
        limpar(pasta);
        return res.status(500).json({ erro: 'Nao rolou baixar esse trecho. Confere o link e os tempos.', detalhe: (erroSaida || 'sem detalhes').slice(-600) });
      }
      const arquivos = fs.readdirSync(pasta).filter(f => f.startsWith('corte'));
      if (!arquivos.length) { limpar(pasta); return res.status(500).json({ erro: 'O corte nao foi gerado. Tenta de novo.' }); }
      const caminho = path.join(pasta, arquivos[0]);
      res.download(caminho, `corte_${inicio.replace(/:/g, '-')}_a_${fim.replace(/:/g, '-')}.mp4`, () => limpar(pasta));
    });
  } catch (e) {
    if (pasta) limpar(pasta);
    res.status(500).json({ erro: 'Deu um erro no servidor.', detalhe: String(e.message || e) });
  }
});

function limpar(pasta) { try { fs.rmSync(pasta, { recursive: true, force: true }); } catch (e) {} }

const PORTA = process.env.PORT || 3000;
app.listen(PORTA, () => console.log('Cortador rodando na porta ' + PORTA));
