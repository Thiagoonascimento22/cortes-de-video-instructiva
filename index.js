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
const crypto = require('crypto');

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
const PAGINA = Buffer.from("PCFkb2N0eXBlIGh0bWw+CjxodG1sIGxhbmc9InB0LUJSIj4KPGhlYWQ+CjxtZXRhIGNoYXJzZXQ9InV0Zi04Ij4KPG1ldGEgbmFtZT0idmlld3BvcnQiIGNvbnRlbnQ9IndpZHRoPWRldmljZS13aWR0aCwgaW5pdGlhbC1zY2FsZT0xIj4KPHRpdGxlPkNvcnRhZG9yIMK3IEluc3RydWN0aXZhPC90aXRsZT4KPGxpbmsgcmVsPSJwcmVjb25uZWN0IiBocmVmPSJodHRwczovL2ZvbnRzLmdvb2dsZWFwaXMuY29tIj4KPGxpbmsgcmVsPSJwcmVjb25uZWN0IiBocmVmPSJodHRwczovL2ZvbnRzLmdzdGF0aWMuY29tIiBjcm9zc29yaWdpbj4KPGxpbmsgaHJlZj0iaHR0cHM6Ly9mb250cy5nb29nbGVhcGlzLmNvbS9jc3MyP2ZhbWlseT1Ccmljb2xhZ2UrR3JvdGVzcXVlOm9wc3osd2dodEAxMi4uOTYsNDAwOzEyLi45Niw2MDA7MTIuLjk2LDgwMCZmYW1pbHk9SGFua2VuK0dyb3Rlc2s6d2dodEA0MDA7NTAwOzYwMDs3MDAmZGlzcGxheT1zd2FwIiByZWw9InN0eWxlc2hlZXQiPgo8c3R5bGU+CiAgOnJvb3R7CiAgICAtLWJnOiMwZDBlMTI7IC0tYmcyOiMxNDE1MWI7IC0tcGFuZWw6IzE3MTkyMjsgLS1wYW5lbDI6IzFkMjAyOTsKICAgIC0tbGluZTojMjYyYTM2OyAtLWluazojZWVmMGY1OyAtLW11dGVkOiM5YWEwYjA7IC0tZmFpbnQ6IzY0NmI3ZDsKICAgIC0tYWNjZW50OiNmZjU0MzY7IC0tYWNjZW50MjojZmZiMDNhOyAtLWdvb2Q6IzNkZGM4NDsgLS1sb3c6I2ZmNmE1YTsKICB9CiAgKntib3gtc2l6aW5nOmJvcmRlci1ib3h9CiAgYm9keXsKICAgIG1hcmdpbjowO2ZvbnQtZmFtaWx5OidIYW5rZW4gR3JvdGVzaycsc3lzdGVtLXVpLHNhbnMtc2VyaWY7Y29sb3I6dmFyKC0taW5rKTttaW4taGVpZ2h0OjEwMHZoO2xpbmUtaGVpZ2h0OjEuNTsKICAgIGJhY2tncm91bmQ6cmFkaWFsLWdyYWRpZW50KDExMDBweCA2MDBweCBhdCA4MCUgLTEwJSxyZ2JhKDI1NSw4NCw1NCwuMTIpLHRyYW5zcGFyZW50IDYwJSkscmFkaWFsLWdyYWRpZW50KDkwMHB4IDUwMHB4IGF0IDAlIDAlLHJnYmEoMjU1LDE3Niw1OCwuMDgpLHRyYW5zcGFyZW50IDU1JSksdmFyKC0tYmcpOwogICAgLXdlYmtpdC1mb250LXNtb290aGluZzphbnRpYWxpYXNlZDsKICB9CiAgLndyYXB7bWF4LXdpZHRoOjYyMHB4O21hcmdpbjowIGF1dG87cGFkZGluZzo0MHB4IDIwcHggODBweH0KICBoZWFkZXJ7ZGlzcGxheTpmbGV4O2FsaWduLWl0ZW1zOmNlbnRlcjtnYXA6MTRweDttYXJnaW4tYm90dG9tOjhweH0KICAubG9nb3t3aWR0aDo0NnB4O2hlaWdodDo0NnB4O2JvcmRlci1yYWRpdXM6MTRweDtiYWNrZ3JvdW5kOmxpbmVhci1ncmFkaWVudCgxMzVkZWcsdmFyKC0tYWNjZW50KSx2YXIoLS1hY2NlbnQyKSk7ZGlzcGxheTpncmlkO3BsYWNlLWl0ZW1zOmNlbnRlcjtib3gtc2hhZG93OjAgOHB4IDMwcHggcmdiYSgyNTUsODQsNTQsLjM1KX0KICBoMXtmb250LWZhbWlseTonQnJpY29sYWdlIEdyb3Rlc3F1ZScsc2Fucy1zZXJpZjtmb250LXdlaWdodDo4MDA7Zm9udC1zaXplOjMwcHg7bWFyZ2luOjA7bGV0dGVyLXNwYWNpbmc6LS4wMmVtfQogIC5zdWJ7Y29sb3I6dmFyKC0tbXV0ZWQpO2ZvbnQtc2l6ZToxNHB4O21hcmdpbjoycHggMCAwfQogIC5jYXJke2JhY2tncm91bmQ6bGluZWFyLWdyYWRpZW50KDE4MGRlZyx2YXIoLS1wYW5lbCksdmFyKC0tYmcyKSk7Ym9yZGVyOjFweCBzb2xpZCB2YXIoLS1saW5lKTtib3JkZXItcmFkaXVzOjE2cHg7cGFkZGluZzoyNHB4O21hcmdpbi10b3A6MjZweH0KICBsYWJlbHtkaXNwbGF5OmJsb2NrO2ZvbnQtc2l6ZToxMi41cHg7Zm9udC13ZWlnaHQ6NjAwO2NvbG9yOnZhcigtLW11dGVkKTttYXJnaW46MCAwIDdweDt0ZXh0LXRyYW5zZm9ybTp1cHBlcmNhc2U7bGV0dGVyLXNwYWNpbmc6LjA0ZW19CiAgaW5wdXR7d2lkdGg6MTAwJTtiYWNrZ3JvdW5kOnZhcigtLWJnKTtib3JkZXI6MXB4IHNvbGlkIHZhcigtLWxpbmUpO2JvcmRlci1yYWRpdXM6MTJweDtjb2xvcjp2YXIoLS1pbmspO2ZvbnQtZmFtaWx5OmluaGVyaXQ7Zm9udC1zaXplOjE1cHg7cGFkZGluZzoxM3B4IDE0cHg7b3V0bGluZTpub25lfQogIGlucHV0OmZvY3Vze2JvcmRlci1jb2xvcjp2YXIoLS1hY2NlbnQpfQogIC50aW1lc3tkaXNwbGF5OmZsZXg7Z2FwOjE0cHg7bWFyZ2luLXRvcDoxOHB4fQogIC50aW1lcyA+IGRpdntmbGV4OjF9CiAgLmJ0bnttYXJnaW4tdG9wOjIycHg7d2lkdGg6MTAwJTtib3JkZXI6bm9uZTtjdXJzb3I6cG9pbnRlcjtmb250LWZhbWlseTonQnJpY29sYWdlIEdyb3Rlc3F1ZScsc2Fucy1zZXJpZjtmb250LXdlaWdodDo3MDA7Zm9udC1zaXplOjE2cHg7Y29sb3I6IzFhMGQwOTtiYWNrZ3JvdW5kOmxpbmVhci1ncmFkaWVudCgxMzVkZWcsdmFyKC0tYWNjZW50KSx2YXIoLS1hY2NlbnQyKSk7cGFkZGluZzoxNXB4O2JvcmRlci1yYWRpdXM6MTJweDt0cmFuc2l0aW9uOnRyYW5zZm9ybSAuMTJzLGJveC1zaGFkb3cgLjEycztib3gtc2hhZG93OjAgOHB4IDI0cHggcmdiYSgyNTUsODQsNTQsLjMpO2Rpc3BsYXk6ZmxleDthbGlnbi1pdGVtczpjZW50ZXI7anVzdGlmeS1jb250ZW50OmNlbnRlcjtnYXA6OXB4fQogIC5idG46aG92ZXJ7dHJhbnNmb3JtOnRyYW5zbGF0ZVkoLTFweCk7Ym94LXNoYWRvdzowIDEycHggMzBweCByZ2JhKDI1NSw4NCw1NCwuNDIpfQogIC5idG46ZGlzYWJsZWR7b3BhY2l0eTouNTtjdXJzb3I6bm90LWFsbG93ZWQ7dHJhbnNmb3JtOm5vbmV9CiAgLmhpbnR7Zm9udC1zaXplOjEzcHg7Y29sb3I6dmFyKC0tZmFpbnQpO21hcmdpbi10b3A6MTRweDtsaW5lLWhlaWdodDoxLjZ9CiAgLnN0YXR1c3ttYXJnaW4tdG9wOjIycHg7dGV4dC1hbGlnbjpjZW50ZXI7Zm9udC1zaXplOjE0LjVweDtjb2xvcjp2YXIoLS1tdXRlZCl9CiAgLnNwaW5uZXJ7ZGlzcGxheTppbmxpbmUtYmxvY2s7d2lkdGg6MTZweDtoZWlnaHQ6MTZweDtib3JkZXI6MnB4IHNvbGlkIHZhcigtLWxpbmUpO2JvcmRlci10b3AtY29sb3I6dmFyKC0tYWNjZW50KTtib3JkZXItcmFkaXVzOjUwJTthbmltYXRpb246c3BpbiAuOHMgbGluZWFyIGluZmluaXRlO3ZlcnRpY2FsLWFsaWduOi0zcHg7bWFyZ2luLXJpZ2h0OjhweH0KICBAa2V5ZnJhbWVzIHNwaW57dG97dHJhbnNmb3JtOnJvdGF0ZSgzNjBkZWcpfX0KICAuZXJye21hcmdpbi10b3A6MjBweDtiYWNrZ3JvdW5kOnJnYmEoMjU1LDEwNiw5MCwuMSk7Ym9yZGVyOjFweCBzb2xpZCByZ2JhKDI1NSwxMDYsOTAsLjQpO2NvbG9yOiNmZmIzYWE7cGFkZGluZzoxNHB4IDE2cHg7Ym9yZGVyLXJhZGl1czoxMnB4O2ZvbnQtc2l6ZToxNHB4fQogIC5va3ttYXJnaW4tdG9wOjIycHg7YmFja2dyb3VuZDpyZ2JhKDYxLDIyMCwxMzIsLjA4KTtib3JkZXI6MXB4IHNvbGlkIHJnYmEoNjEsMjIwLDEzMiwuMzUpO2JvcmRlci1yYWRpdXM6MTRweDtwYWRkaW5nOjIwcHg7dGV4dC1hbGlnbjpjZW50ZXJ9CiAgLm9rIHB7bWFyZ2luOjAgMCAxNHB4O2NvbG9yOnZhcigtLWdvb2QpO2ZvbnQtd2VpZ2h0OjYwMH0KICAub2sgYXtkaXNwbGF5OmlubGluZS1ibG9jaztiYWNrZ3JvdW5kOnZhcigtLWdvb2QpO2NvbG9yOiMwNjIwMTM7Zm9udC13ZWlnaHQ6NzAwO2ZvbnQtZmFtaWx5OidCcmljb2xhZ2UgR3JvdGVzcXVlJyxzYW5zLXNlcmlmO3RleHQtZGVjb3JhdGlvbjpub25lO3BhZGRpbmc6MTJweCAyMnB4O2JvcmRlci1yYWRpdXM6MTFweH0KICBmb290ZXJ7bWFyZ2luLXRvcDo0MHB4O3RleHQtYWxpZ246Y2VudGVyO2NvbG9yOnZhcigtLWZhaW50KTtmb250LXNpemU6MTJweH0KPC9zdHlsZT4KPC9oZWFkPgo8Ym9keT4KPGRpdiBjbGFzcz0id3JhcCI+CiAgPGhlYWRlcj4KICAgIDxkaXYgY2xhc3M9ImxvZ28iPgogICAgICA8c3ZnIHdpZHRoPSIyNCIgaGVpZ2h0PSIyNCIgdmlld0JveD0iMCAwIDI0IDI0IiBmaWxsPSJub25lIiBzdHJva2U9IiMxYTBkMDkiIHN0cm9rZS13aWR0aD0iMi4yIiBzdHJva2UtbGluZWNhcD0icm91bmQiIHN0cm9rZS1saW5lam9pbj0icm91bmQiPjxjaXJjbGUgY3g9IjYiIGN5PSI2IiByPSIzIi8+PGNpcmNsZSBjeD0iNiIgY3k9IjE4IiByPSIzIi8+PGxpbmUgeDE9IjIwIiB5MT0iNCIgeDI9IjguMTIiIHkyPSIxNS44OCIvPjxsaW5lIHgxPSIxNC40NyIgeTE9IjE0LjQ4IiB4Mj0iMjAiIHkyPSIyMCIvPjxsaW5lIHgxPSI4LjEyIiB5MT0iOC4xMiIgeDI9IjEyIiB5Mj0iMTIiLz48L3N2Zz4KICAgIDwvZGl2PgogICAgPGRpdj48aDE+Q29ydGFkb3I8L2gxPjxwIGNsYXNzPSJzdWIiPkNvbGEgbyBsaW5rLCBlc2NvbGhlIG8gdHJlY2hvLCBiYWl4YSBvIGNvcnRlLjwvcD48L2Rpdj4KICA8L2hlYWRlcj4KCiAgPGRpdiBjbGFzcz0iY2FyZCI+CiAgICA8bGFiZWwgZm9yPSJ1cmwiPkxpbmsgZG8gdsOtZGVvIChZb3VUdWJlIG91IG0zdTggZG8gUGFuZGEpPC9sYWJlbD4KICAgIDxpbnB1dCBpZD0idXJsIiB0eXBlPSJ0ZXh0IiBwbGFjZWhvbGRlcj0iaHR0cHM6Ly95b3V0dWJlLmNvbS93YXRjaD92PS4uLiBvdSBodHRwczovLy4uLnBhbmRhLi4uL3BsYXlsaXN0Lm0zdTguLi4iPgogICAgPGRpdiBjbGFzcz0idGltZXMiPgogICAgICA8ZGl2PjxsYWJlbCBmb3I9ImluaSI+RG8gbWludXRvPC9sYWJlbD48aW5wdXQgaWQ9ImluaSIgdHlwZT0idGV4dCIgcGxhY2Vob2xkZXI9IjQ6MzIiPjwvZGl2PgogICAgICA8ZGl2PjxsYWJlbCBmb3I9ImZpbSI+QXTDqSBvIG1pbnV0bzwvbGFiZWw+PGlucHV0IGlkPSJmaW0iIHR5cGU9InRleHQiIHBsYWNlaG9sZGVyPSI2OjEwIj48L2Rpdj4KICAgIDwvZGl2PgogICAgPGJ1dHRvbiBjbGFzcz0iYnRuIiBpZD0iZ28iIG9uY2xpY2s9ImNvcnRhcigpIj4KICAgICAgPHN2ZyB3aWR0aD0iMTgiIGhlaWdodD0iMTgiIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0ibm9uZSIgc3Ryb2tlPSIjMWEwZDA5IiBzdHJva2Utd2lkdGg9IjIuNCIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIiBzdHJva2UtbGluZWpvaW49InJvdW5kIj48Y2lyY2xlIGN4PSI2IiBjeT0iNiIgcj0iMyIvPjxjaXJjbGUgY3g9IjYiIGN5PSIxOCIgcj0iMyIvPjxsaW5lIHgxPSIyMCIgeTE9IjQiIHgyPSI4LjEyIiB5Mj0iMTUuODgiLz48bGluZSB4MT0iMTQuNDciIHkxPSIxNC40OCIgeDI9IjIwIiB5Mj0iMjAiLz48L3N2Zz4KICAgICAgQ29ydGFyIGUgYmFpeGFyCiAgICA8L2J1dHRvbj4KICAgIDxwIGNsYXNzPSJoaW50Ij5Fc2NyZXZlIG8gdGVtcG8gYXNzaW06IDxiPjQ6MzI8L2I+IChtaW51dG8gZSBzZWd1bmRvKS4gU2UgcGFzc2FyIGRlIHVtYSBob3JhLCB1c2EgPGI+MTowNDoxMDwvYj4uIFByYSBhdWxhIGRhIENhZGVtaSwgY29sYSBhIFVSTCBtM3U4IHF1ZSB2b2PDqiBwZWdvdSBkbyBEZXZUb29scy48L3A+CiAgPC9kaXY+CgogIDxkaXYgaWQ9InN0YXR1cyI+PC9kaXY+CgogIDxmb290ZXI+Q29ydGFkb3IgwrcgSW5zdHJ1Y3RpdmE8L2Zvb3Rlcj4KPC9kaXY+Cgo8c2NyaXB0Pgpjb25zdCBBUEkgPSAiIjsKCmNvbnN0ICQgPSBpZCA9PiBkb2N1bWVudC5nZXRFbGVtZW50QnlJZChpZCk7Cgphc3luYyBmdW5jdGlvbiBjb3J0YXIoKXsKICBjb25zdCB1cmwgPSAkKCd1cmwnKS52YWx1ZS50cmltKCk7CiAgY29uc3QgaW5pY2lvID0gJCgnaW5pJykudmFsdWUudHJpbSgpOwogIGNvbnN0IGZpbSA9ICQoJ2ZpbScpLnZhbHVlLnRyaW0oKTsKICAkKCdzdGF0dXMnKS5pbm5lckhUTUwgPSAnJzsKCiAgaWYoIXVybCl7IGVycm8oJ0NvbGEgbyBsaW5rIGRvIHZpZGVvLicpOyByZXR1cm47IH0KICBpZighaW5pY2lvIHx8ICFmaW0peyBlcnJvKCdQcmVlbmNoZSBvIG1pbnV0byBkZSBpbmljaW8gZSBkZSBmaW0uJyk7IHJldHVybjsgfQoKICAkKCdnbycpLmRpc2FibGVkID0gdHJ1ZTsKICAkKCdzdGF0dXMnKS5pbm5lckhUTUwgPSAnPGRpdiBjbGFzcz0ic3RhdHVzIj48c3BhbiBjbGFzcz0ic3Bpbm5lciI+PC9zcGFuPkJhaXhhbmRvIGUgY29ydGFuZG8gbyB0cmVjaG8uLi4gKHBvZGUgbGV2YXIgZGUgYWxndW5zIHNlZ3VuZG9zIGEgMSBtaW51dG8pPC9kaXY+JzsKCiAgdHJ5ewogICAgY29uc3QgcmVzID0gYXdhaXQgZmV0Y2goQVBJICsgJy9jb3J0YXInLCB7CiAgICAgIG1ldGhvZDonUE9TVCcsCiAgICAgIGhlYWRlcnM6eydDb250ZW50LVR5cGUnOidhcHBsaWNhdGlvbi9qc29uJ30sCiAgICAgIGJvZHk6IEpTT04uc3RyaW5naWZ5KHsgdXJsLCBpbmljaW8sIGZpbSB9KQogICAgfSk7CiAgICBjb25zdCB0aXBvID0gcmVzLmhlYWRlcnMuZ2V0KCdjb250ZW50LXR5cGUnKSB8fCAnJzsKICAgIGlmKHRpcG8uaW5jbHVkZXMoJ2FwcGxpY2F0aW9uL2pzb24nKSl7CiAgICAgIGNvbnN0IGogPSBhd2FpdCByZXMuanNvbigpOwogICAgICBlcnJvKGouZXJybyB8fCAnTmFvIGNvbnNlZ3VpIGNvcnRhciBlc3NlIHZpZGVvLicsIGouZGV0YWxoZSk7CiAgICAgIHJldHVybjsKICAgIH0KICAgIGNvbnN0IGJsb2IgPSBhd2FpdCByZXMuYmxvYigpOwogICAgY29uc3QgbGluayA9IFVSTC5jcmVhdGVPYmplY3RVUkwoYmxvYik7CiAgICBjb25zdCBub21lID0gYGNvcnRlXyR7aW5pY2lvLnJlcGxhY2UoLzovZywnLScpfV9hXyR7ZmltLnJlcGxhY2UoLzovZywnLScpfS5tcDRgOwogICAgY29uc3QgYSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2EnKTsKICAgIGEuaHJlZiA9IGxpbms7IGEuZG93bmxvYWQgPSBub21lOyBkb2N1bWVudC5ib2R5LmFwcGVuZENoaWxkKGEpOyBhLmNsaWNrKCk7IGEucmVtb3ZlKCk7CiAgICAkKCdzdGF0dXMnKS5pbm5lckhUTUwgPSBgPGRpdiBjbGFzcz0ib2siPjxwPuKckyBDb3J0ZSBwcm9udG8hIE8gZG93bmxvYWQgY29tZcOnb3UuPC9wPjxhIGhyZWY9IiR7bGlua30iIGRvd25sb2FkPSIke25vbWV9Ij5CYWl4YXIgZGUgbm92bzwvYT48L2Rpdj5gOwogIH1jYXRjaChlKXsKICAgIGVycm8oJ05hbyBjb25zZWd1aSBmYWxhciBjb20gbyBzZXJ2aWRvci4gQ29uZmVyZSBzZSBvIFJhaWx3YXkgdGEgbm8gYXIuICgnKyBlLm1lc3NhZ2UgKycpJyk7CiAgfWZpbmFsbHl7CiAgICAkKCdnbycpLmRpc2FibGVkID0gZmFsc2U7CiAgfQp9CmZ1bmN0aW9uIGVycm8obXNnLCBkZXRhbGhlKXsKICBsZXQgaCA9ICc8ZGl2IGNsYXNzPSJlcnIiPicgKyBtc2c7CiAgaWYoZGV0YWxoZSl7IGggKz0gJzxkaXYgc3R5bGU9Im1hcmdpbi10b3A6MTBweDtmb250LXNpemU6MTEuNXB4O2NvbG9yOiNjOWEwOGU7d2hpdGUtc3BhY2U6cHJlLXdyYXA7Zm9udC1mYW1pbHk6bW9ub3NwYWNlO2xpbmUtaGVpZ2h0OjEuNSI+JyArIFN0cmluZyhkZXRhbGhlKS5yZXBsYWNlKC9bJjw+XS9nLGM9Pih7JyYnOicmYW1wOycsJzwnOicmbHQ7JywnPic6JyZndDsnfVtjXSkpICsgJzwvZGl2Pic7IH0KICBoICs9ICc8L2Rpdj4nOwogICQoJ3N0YXR1cycpLmlubmVySFRNTCA9IGg7Cn0KPC9zY3JpcHQ+CjwvYm9keT4KPC9odG1sPgo=", 'base64').toString('utf8');

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

// ---- Baixa o ffmpeg (eugeneware/ffmpeg-static - .gz, descompacta com zlib nativo) ----
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
        if (r.statusCode !== 200) return reject(new Error('Nao consegui baixar o ffmpeg (' + r.statusCode + ')'));
        const out = fs.createWriteStream(FFMPEG);
        r.pipe(zlib.createGunzip()).pipe(out);
        out.on('finish', () => out.close(() => { fs.chmodSync(FFMPEG, 0o755); console.log('[cortador] ffmpeg pronto'); resolve(); }));
        out.on('error', reject);
      }).on('error', reject);
    };
    baixar(FFMPEG_URL);
  });
  return prontoFfmpeg;
}

// ---- Cache de videos baixados (1 hora) ----
const CACHE_DIR = path.join(os.tmpdir(), 'cortador-cache');
const CACHE_TTL_MS = 60 * 60 * 1000;

function cachePathPara(url, ext) {
  const hash = crypto.createHash('md5').update(url).digest('hex');
  return path.join(CACHE_DIR, hash + '.' + (ext || 'mp4'));
}

function limparCacheAntigo() {
  try {
    if (!fs.existsSync(CACHE_DIR)) return;
    const agora = Date.now();
    for (const f of fs.readdirSync(CACHE_DIR)) {
      const fp = path.join(CACHE_DIR, f);
      try {
        const stat = fs.statSync(fp);
        if (agora - stat.mtimeMs > CACHE_TTL_MS) {
          fs.unlinkSync(fp);
          console.log('[cortador] cache: removido', f, '(velho)');
        }
      } catch (e) {}
    }
  } catch (e) {}
}

function linkValido(u) {
  if (typeof u !== 'string') return false;
  const t = u.trim();
  if (/^https:\/\/(www\.|m\.)?(youtube\.com\/|youtu\.be\/)/.test(t)) return true;
  if (/^https?:\/\/.+\.m3u8(\?|$|\.)/.test(t)) return true;
  return false;
}
function detectarTipoUrl(u) {
  if (/youtu\.?be/.test(u)) return 'youtube';
  if (/\.m3u8/.test(u)) return 'hls';
  return null;
}
function origemDaUrl(u) {
  try { return new URL(u).origin; } catch (e) { return null; }
}
// ---- Helpers de download HTTP nativo do Node (sem ffmpeg) ----
function baixarTexto(url, headers) {
  return new Promise((resolve, reject) => {
    const tentar = (u, redirectsRestantes = 5) => {
      const opts = { headers: headers || {} };
      https.get(u, opts, (r) => {
        if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location && redirectsRestantes > 0) {
          return tentar(new URL(r.headers.location, u).toString(), redirectsRestantes - 1);
        }
        if (r.statusCode !== 200) return reject(new Error('HTTP ' + r.statusCode + ' em ' + u));
        let data = '';
        r.setEncoding('utf8');
        r.on('data', chunk => { data += chunk; });
        r.on('end', () => resolve(data));
      }).on('error', reject);
    };
    tentar(url);
  });
}

function baixarBinario(url, headers, destinoArquivo) {
  return new Promise((resolve, reject) => {
    const tentar = (u, redirectsRestantes = 5) => {
      const opts = { headers: headers || {} };
      https.get(u, opts, (r) => {
        if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location && redirectsRestantes > 0) {
          return tentar(new URL(r.headers.location, u).toString(), redirectsRestantes - 1);
        }
        if (r.statusCode !== 200) return reject(new Error('HTTP ' + r.statusCode + ' em ' + u));
        const out = fs.createWriteStream(destinoArquivo);
        r.pipe(out);
        out.on('finish', () => out.close(() => resolve()));
        out.on('error', reject);
      }).on('error', reject);
    };
    tentar(url);
  });
}

function parseM3u8(texto) {
  const linhas = texto.split('\n').map(l => l.trim()).filter(l => l);
  const ehMaster = texto.includes('#EXT-X-STREAM-INF:');
  const itens = [];
  if (ehMaster) {
    let info = null;
    for (const linha of linhas) {
      if (linha.startsWith('#EXT-X-STREAM-INF:')) {
        const bw = linha.match(/BANDWIDTH=(\d+)/);
        const res = linha.match(/RESOLUTION=(\d+)x(\d+)/);
        info = { bandwidth: bw ? parseInt(bw[1]) : 0, altura: res ? parseInt(res[2]) : 0 };
      } else if (!linha.startsWith('#') && info) {
        itens.push({ ...info, url: linha });
        info = null;
      }
    }
  } else {
    for (const linha of linhas) {
      if (!linha.startsWith('#') && linha) itens.push({ url: linha });
    }
  }
  return { ehMaster, itens };
}

async function baixarSegmentosParalelo(urlsAbsolutas, headers, pastaTemp, paralelos = 4) {
  const arquivos = new Array(urlsAbsolutas.length);
  let proximo = 0;
  async function worker() {
    while (true) {
      const idx = proximo++;
      if (idx >= urlsAbsolutas.length) break;
      const dest = path.join(pastaTemp, `seg_${String(idx).padStart(5, '0')}.ts`);
      let tentativas = 0;
      while (tentativas < 3) {
        try {
          await baixarBinario(urlsAbsolutas[idx], headers, dest);
          arquivos[idx] = dest;
          break;
        } catch (e) {
          tentativas++;
          if (tentativas >= 3) throw new Error(`Segmento ${idx} falhou: ${e.message}`);
          await new Promise(r => setTimeout(r, 500 * tentativas));
        }
      }
    }
  }
  const workers = Array.from({ length: paralelos }, () => worker());
  await Promise.all(workers);
  return arquivos;
}

function concatenarArquivos(arquivos, destino) {
  return new Promise((resolve, reject) => {
    const out = fs.createWriteStream(destino);
    let i = 0;
    function proximo() {
      if (i >= arquivos.length) { out.end(); return; }
      const inp = fs.createReadStream(arquivos[i++]);
      inp.pipe(out, { end: false });
      inp.on('end', proximo);
      inp.on('error', reject);
    }
    out.on('finish', resolve);
    out.on('error', reject);
    proximo();
  });
}

async function baixarHLSCompleto(urlM3u8, destinoMp4) {
  const origem = origemDaUrl(urlM3u8);
  const headers = origem ? { 'Origin': origem, 'Referer': origem + '/' } : {};

  // 1. Baixar master playlist
  console.log('[cortador-hls] 1/5 - baixando master playlist');
  const masterTxt = await baixarTexto(urlM3u8, headers);
  const master = parseM3u8(masterTxt);
  console.log('[cortador-hls] master:', master.ehMaster ? `${master.itens.length} variants` : 'ja eh playlist de midia');

  // 2. Escolher variant (720p ou menor pra economizar banda)
  let urlMedia = urlM3u8;
  if (master.ehMaster) {
    if (master.itens.length === 0) throw new Error('Master playlist sem variants');
    const ordenado = [...master.itens].sort((a, b) => b.bandwidth - a.bandwidth);
    const escolhido = ordenado.find(v => v.altura > 0 && v.altura <= 720) || ordenado[ordenado.length - 1];
    urlMedia = new URL(escolhido.url, urlM3u8).toString();
    console.log('[cortador-hls] variant escolhido:', escolhido.altura + 'p', '|', escolhido.bandwidth, 'bps');
  }

  // 3. Baixar media playlist (lista de .ts)
  console.log('[cortador-hls] 2/5 - baixando playlist de midia');
  const mediaTxt = await baixarTexto(urlMedia, headers);
  const media = parseM3u8(mediaTxt);
  if (media.itens.length === 0) throw new Error('Nenhum segmento .ts encontrado');
  console.log('[cortador-hls] segmentos encontrados:', media.itens.length);

  // 4. Baixar todos segmentos em paralelo (4 conexoes)
  const pastaTemp = fs.mkdtempSync(path.join(os.tmpdir(), 'hls-segs-'));
  try {
    const urlsAbs = media.itens.map(s => new URL(s.url, urlMedia).toString());
    console.log('[cortador-hls] 3/5 - baixando', urlsAbs.length, 'segmentos (4 paralelo)');
    const arquivos = await baixarSegmentosParalelo(urlsAbs, headers, pastaTemp);

    // 5. Concatenar em um unico .ts
    const tsPath = path.join(pastaTemp, 'completo.ts');
    console.log('[cortador-hls] 4/5 - concatenando segmentos');
    await concatenarArquivos(arquivos, tsPath);
    const tsSize = (fs.statSync(tsPath).size / 1024 / 1024).toFixed(1);
    console.log('[cortador-hls] .ts montado:', tsSize, 'MB');

    // 6. ffmpeg remux .ts -> .mp4 (operacao local, rapida, deve funcionar)
    console.log('[cortador-hls] 5/5 - ffmpeg remux ts->mp4');
    const r = await executar(FFMPEG, [
      '-y',
      '-i', tsPath,
      '-c', 'copy',
      '-bsf:a', 'aac_adtstoasc',
      destinoMp4,
    ], 'ffmpeg-remux');
    if (r.codigo !== 0) throw new Error('ffmpeg remux falhou: codigo=' + r.codigo + ' sinal=' + r.sinal + ' | ' + (r.stderr || '').slice(-500));
  } finally {
    try { fs.rmSync(pastaTemp, { recursive: true, force: true }); } catch (e) {}
  }
}

// ---- Helpers de download HTTP nativo do Node (sem ffmpeg) FIM ----
function tempoValido(t) {
  return typeof t === 'string' && /^(\d{1,2}:)?\d{1,2}:\d{2}$|^\d{1,3}(:\d{2}){0,2}$|^\d+$/.test(t.trim());
}
function paraSegundos(t) {
  const p = String(t).trim().split(':').map(Number);
  if (p.some(isNaN)) return NaN;
  return p.reduce((acc, v) => acc * 60 + v, 0);
}

app.get('/', (_req, res) => res.type('html').send(PAGINA));
app.get('/status', (_req, res) => {
  let videosCacheados = 0;
  try { if (fs.existsSync(CACHE_DIR)) videosCacheados = fs.readdirSync(CACHE_DIR).length; } catch (e) {}
  res.json({ ok: true, servico: 'cortador', versao: 26, cookies: cookiesOk, proxy: PROXY_URL ? (process.env.PROXY_HOST + ':' + process.env.PROXY_PORT) : false, videosNoCache: videosCacheados });
});

// Helper: roda um comando e retorna {codigo, sinal, stdout, stderr}
function executar(cmd, args, label) {
  return new Promise((resolve) => {
    console.log('[cortador]', label, 'iniciando...');
    const proc = spawn(cmd, args);
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', d => { stdout += d.toString(); });
    proc.stderr.on('data', d => { stderr += d.toString(); });
    proc.on('close', (codigo, sinal) => {
      console.log('[cortador]', label, 'terminou com codigo', codigo, 'sinal', sinal);
      if (stderr) console.log('[cortador] stderr de', label + ':\n' + stderr.slice(-1500));
      resolve({ codigo, sinal, stdout, stderr });
    });
    proc.on('error', (err) => {
      resolve({ codigo: -1, sinal: null, stdout: '', stderr: 'erro ao executar: ' + err.message });
    });
  });
}

app.post('/cortar', async (req, res) => {
  const url = (req.body.url || '').trim();
  const inicio = String(req.body.inicio || '').trim();
  const fim = String(req.body.fim || '').trim();

  if (!linkValido(url)) return res.status(400).json({ erro: 'Cole um link valido do YouTube ou uma URL m3u8 do Panda Video.' });
  if (!tempoValido(inicio) || !tempoValido(fim)) return res.status(400).json({ erro: 'Use o formato de tempo certo, tipo 4:32 ou 1:04:10.' });

  const si = paraSegundos(inicio), sf = paraSegundos(fim);
  if (isNaN(si) || isNaN(sf) || sf <= si) return res.status(400).json({ erro: 'O fim precisa ser depois do inicio.' });
  if (sf - si > MAX_SEGUNDOS) return res.status(400).json({ erro: 'O corte ta muito longo (maximo 15 minutos por vez).' });

  const tipoUrl = detectarTipoUrl(url);
  console.log('[cortador] tipo de URL:', tipoUrl);

  let pasta;
  try {
    await garantirYtdlp();
    await garantirFfmpeg();
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    limparCacheAntigo();
    pasta = fs.mkdtempSync(path.join(os.tmpdir(), 'corte-'));
    const fullPath = cachePathPara(url, 'mp4');
    const cortePath = path.join(pasta, 'corte.mp4');
    const duracao = sf - si;
    // Cache vale se arquivo existe E tem >= 1MB (arquivos menores sao corrompidos)
    let cacheHit = false;
    if (fs.existsSync(fullPath)) {
      try {
        if (fs.statSync(fullPath).size > 1024 * 1024) cacheHit = true;
        else { fs.unlinkSync(fullPath); console.log('[cortador] cache invalido (< 1MB), removendo'); }
      } catch (e) {}
    }

    // ETAPA 1: baixar vídeo inteiro (PULA SE JÁ TEM NO CACHE VALIDO)
    if (cacheHit) {
      console.log('[cortador] CACHE HIT - usando video ja baixado:', path.basename(fullPath));
    } else {
      const t1 = Date.now();
      let r1 = { codigo: 0, sinal: null, stderr: '', stdout: '' };

      if (tipoUrl === 'youtube') {
        console.log('[cortador] CACHE MISS - baixando do YouTube via yt-dlp | proxy:', PROXY_URL ? 'sim' : 'nao');
        r1 = await executar(YTDLP, [
          '--no-playlist', '--no-warnings', '--no-progress',
          '--extractor-args', 'youtube:player_client=tv,web_safari,default',
          ...(cookiesOk ? ['--cookies', COOKIES_PATH] : []),
          ...(PROXY_URL ? ['--proxy', PROXY_URL] : []),
          '--ffmpeg-location', FFMPEG,
          '-N', '4',
          '-f', 'bv*[vcodec^=avc1][height<=720][fps<=30]+ba[ext=m4a]/bv*[vcodec^=avc1][height<=720]+ba[ext=m4a]/b[ext=mp4][height<=720]/b[ext=mp4]/b',
          '--merge-output-format', 'mp4',
          '-o', fullPath,
          url,
        ], 'yt-dlp-download');
      } else if (tipoUrl === 'hls') {
        console.log('[cortador] CACHE MISS - baixando HLS (downloader Node nativo)');
        try {
          await baixarHLSCompleto(url, fullPath);
        } catch (e) {
          r1 = { codigo: -1, sinal: null, stderr: e.message, stdout: '' };
        }
      } else {
        limpar(pasta);
        return res.status(400).json({ erro: 'Tipo de URL nao suportado.' });
      }

      const dt1 = ((Date.now() - t1) / 1000).toFixed(1);
      let baixadoMB = '?';
      try { if (fs.existsSync(fullPath)) baixadoMB = (fs.statSync(fullPath).size / 1024 / 1024).toFixed(1); } catch (e) {}
      console.log('[cortador] download levou', dt1, 's | arquivo:', baixadoMB, 'MB');

      if (r1.codigo !== 0 || !fs.existsSync(fullPath) || fs.statSync(fullPath).size < 1024 * 1024) {
        try { if (fs.existsSync(fullPath)) fs.unlinkSync(fullPath); } catch (e) {}
        limpar(pasta);
        return res.status(500).json({ erro: 'Nao consegui baixar esse video. Confere o link.', detalhe: `codigo=${r1.codigo} sinal=${r1.sinal} baixou=${baixadoMB}MB | ${(r1.stderr || r1.stdout || 'sem detalhes').slice(-1500)}` });
      }
    }

    // ETAPA 2: cortar localmente (input agora eh sempre .mp4 - pra YouTube e HLS)
    const t2 = Date.now();
    let tamanhoMB = '?';
    try { tamanhoMB = (fs.statSync(fullPath).size / 1024 / 1024).toFixed(1); } catch (e) {}
    console.log('[cortador] cortando | inicio', si, 's | duracao', duracao, 's | input', tamanhoMB, 'MB');

    const r2 = await executar(FFMPEG, [
      '-y',
      '-ss', String(si),
      '-i', fullPath,
      '-t', String(duracao),
      '-c', 'copy',
      '-avoid_negative_ts', 'make_zero',
      cortePath,
    ], 'ffmpeg-cut');
    const dt2 = ((Date.now() - t2) / 1000).toFixed(1);
    console.log('[cortador] cut levou', dt2, 's | cache:', cacheHit ? 'HIT' : 'MISS');

    if (r2.codigo !== 0 || !fs.existsSync(cortePath)) {
      limpar(pasta);
      return res.status(500).json({ erro: 'Baixei o video mas nao consegui cortar.', detalhe: `codigo=${r2.codigo} sinal=${r2.sinal} tamanho=${tamanhoMB}MB | ${(r2.stderr || 'sem detalhes').slice(-1500)}` });
    }

    res.download(cortePath, `corte_${inicio.replace(/:/g, '-')}_a_${fim.replace(/:/g, '-')}.mp4`, () => limpar(pasta));
  } catch (e) {
    if (pasta) limpar(pasta);
    res.status(500).json({ erro: 'Deu um erro no servidor.', detalhe: String(e.message || e) });
  }
});

function limpar(pasta) { try { fs.rmSync(pasta, { recursive: true, force: true }); } catch (e) {} }

const PORTA = process.env.PORT || 3000;
app.listen(PORTA, () => console.log('Cortador rodando na porta ' + PORTA));
