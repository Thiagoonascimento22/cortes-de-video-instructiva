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
const MAX_SEGUNDOS = 60 * 60;

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
const PAGINA = Buffer.from("PCFkb2N0eXBlIGh0bWw+CjxodG1sIGxhbmc9InB0LUJSIj4KPGhlYWQ+CjxtZXRhIGNoYXJzZXQ9InV0Zi04Ij4KPG1ldGEgbmFtZT0idmlld3BvcnQiIGNvbnRlbnQ9IndpZHRoPWRldmljZS13aWR0aCwgaW5pdGlhbC1zY2FsZT0xIj4KPHRpdGxlPkNvcnRhZG9yIMK3IEluc3RydWN0aXZhPC90aXRsZT4KPGxpbmsgcmVsPSJwcmVjb25uZWN0IiBocmVmPSJodHRwczovL2ZvbnRzLmdvb2dsZWFwaXMuY29tIj4KPGxpbmsgcmVsPSJwcmVjb25uZWN0IiBocmVmPSJodHRwczovL2ZvbnRzLmdzdGF0aWMuY29tIiBjcm9zc29yaWdpbj4KPGxpbmsgaHJlZj0iaHR0cHM6Ly9mb250cy5nb29nbGVhcGlzLmNvbS9jc3MyP2ZhbWlseT1Ccmljb2xhZ2UrR3JvdGVzcXVlOm9wc3osd2dodEAxMi4uOTYsNDAwOzEyLi45Niw2MDA7MTIuLjk2LDgwMCZmYW1pbHk9SGFua2VuK0dyb3Rlc2s6d2dodEA0MDA7NTAwOzYwMDs3MDAmZGlzcGxheT1zd2FwIiByZWw9InN0eWxlc2hlZXQiPgo8c3R5bGU+CiAgOnJvb3R7CiAgICAtLWJnOiMwZDBlMTI7IC0tYmcyOiMxNDE1MWI7IC0tcGFuZWw6IzE3MTkyMjsgLS1wYW5lbDI6IzFkMjAyOTsKICAgIC0tbGluZTojMjYyYTM2OyAtLWluazojZWVmMGY1OyAtLW11dGVkOiM5YWEwYjA7IC0tZmFpbnQ6IzY0NmI3ZDsKICAgIC0tYWNjZW50OiNmZjU0MzY7IC0tYWNjZW50MjojZmZiMDNhOyAtLWdvb2Q6IzNkZGM4NDsgLS1sb3c6I2ZmNmE1YTsKICB9CiAgKntib3gtc2l6aW5nOmJvcmRlci1ib3h9CiAgYm9keXsKICAgIG1hcmdpbjowO2ZvbnQtZmFtaWx5OidIYW5rZW4gR3JvdGVzaycsc3lzdGVtLXVpLHNhbnMtc2VyaWY7Y29sb3I6dmFyKC0taW5rKTttaW4taGVpZ2h0OjEwMHZoO2xpbmUtaGVpZ2h0OjEuNTsKICAgIGJhY2tncm91bmQ6cmFkaWFsLWdyYWRpZW50KDExMDBweCA2MDBweCBhdCA4MCUgLTEwJSxyZ2JhKDI1NSw4NCw1NCwuMTIpLHRyYW5zcGFyZW50IDYwJSkscmFkaWFsLWdyYWRpZW50KDkwMHB4IDUwMHB4IGF0IDAlIDAlLHJnYmEoMjU1LDE3Niw1OCwuMDgpLHRyYW5zcGFyZW50IDU1JSksdmFyKC0tYmcpOwogICAgLXdlYmtpdC1mb250LXNtb290aGluZzphbnRpYWxpYXNlZDsKICB9CiAgLndyYXB7bWF4LXdpZHRoOjYyMHB4O21hcmdpbjowIGF1dG87cGFkZGluZzo0MHB4IDIwcHggODBweH0KICBoZWFkZXJ7ZGlzcGxheTpmbGV4O2FsaWduLWl0ZW1zOmNlbnRlcjtnYXA6MTRweDttYXJnaW4tYm90dG9tOjhweH0KICAubG9nb3t3aWR0aDo0NnB4O2hlaWdodDo0NnB4O2JvcmRlci1yYWRpdXM6MTRweDtiYWNrZ3JvdW5kOmxpbmVhci1ncmFkaWVudCgxMzVkZWcsdmFyKC0tYWNjZW50KSx2YXIoLS1hY2NlbnQyKSk7ZGlzcGxheTpncmlkO3BsYWNlLWl0ZW1zOmNlbnRlcjtib3gtc2hhZG93OjAgOHB4IDMwcHggcmdiYSgyNTUsODQsNTQsLjM1KX0KICBoMXtmb250LWZhbWlseTonQnJpY29sYWdlIEdyb3Rlc3F1ZScsc2Fucy1zZXJpZjtmb250LXdlaWdodDo4MDA7Zm9udC1zaXplOjMwcHg7bWFyZ2luOjA7bGV0dGVyLXNwYWNpbmc6LS4wMmVtfQogIC5zdWJ7Y29sb3I6dmFyKC0tbXV0ZWQpO2ZvbnQtc2l6ZToxNHB4O21hcmdpbjoycHggMCAwfQogIC5jYXJke2JhY2tncm91bmQ6bGluZWFyLWdyYWRpZW50KDE4MGRlZyx2YXIoLS1wYW5lbCksdmFyKC0tYmcyKSk7Ym9yZGVyOjFweCBzb2xpZCB2YXIoLS1saW5lKTtib3JkZXItcmFkaXVzOjE2cHg7cGFkZGluZzoyNHB4O21hcmdpbi10b3A6MjZweH0KICBsYWJlbHtkaXNwbGF5OmJsb2NrO2ZvbnQtc2l6ZToxMi41cHg7Zm9udC13ZWlnaHQ6NjAwO2NvbG9yOnZhcigtLW11dGVkKTttYXJnaW46MCAwIDdweDt0ZXh0LXRyYW5zZm9ybTp1cHBlcmNhc2U7bGV0dGVyLXNwYWNpbmc6LjA0ZW19CiAgaW5wdXQsc2VsZWN0e3dpZHRoOjEwMCU7YmFja2dyb3VuZDp2YXIoLS1iZyk7Ym9yZGVyOjFweCBzb2xpZCB2YXIoLS1saW5lKTtib3JkZXItcmFkaXVzOjEycHg7Y29sb3I6dmFyKC0taW5rKTtmb250LWZhbWlseTppbmhlcml0O2ZvbnQtc2l6ZToxNXB4O3BhZGRpbmc6MTNweCAxNHB4O291dGxpbmU6bm9uZX0KICBpbnB1dDpmb2N1cyxzZWxlY3Q6Zm9jdXN7Ym9yZGVyLWNvbG9yOnZhcigtLWFjY2VudCl9CiAgc2VsZWN0e2FwcGVhcmFuY2U6bm9uZTstd2Via2l0LWFwcGVhcmFuY2U6bm9uZTtiYWNrZ3JvdW5kLWltYWdlOnVybCgiZGF0YTppbWFnZS9zdmcreG1sO3V0ZjgsPHN2ZyB4bWxucz0naHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmcnIHZpZXdCb3g9JzAgMCAxMiAxMicgZmlsbD0nbm9uZScgc3Ryb2tlPSclMjM5YWEwYjAnIHN0cm9rZS13aWR0aD0nMS41JyBzdHJva2UtbGluZWNhcD0ncm91bmQnIHN0cm9rZS1saW5lam9pbj0ncm91bmQnPjxwb2x5bGluZSBwb2ludHM9JzMsNSA2LDggOSw1Jy8+PC9zdmc+Iik7YmFja2dyb3VuZC1yZXBlYXQ6bm8tcmVwZWF0O2JhY2tncm91bmQtcG9zaXRpb246cmlnaHQgMTRweCBjZW50ZXI7YmFja2dyb3VuZC1zaXplOjE0cHg7cGFkZGluZy1yaWdodDo0MnB4O2N1cnNvcjpwb2ludGVyfQogIC50aW1lc3tkaXNwbGF5OmZsZXg7Z2FwOjE0cHg7bWFyZ2luLXRvcDoxOHB4fQogIC50aW1lcyA+IGRpdntmbGV4OjF9CiAgLmZvcm1hdG8tYmxvY297bWFyZ2luLXRvcDoxOHB4fQogIC50ZXh0by1ibG9jb3ttYXJnaW4tdG9wOjE4cHg7ZGlzcGxheTpub25lfQogIC50ZXh0by1ibG9jby5zaG93e2Rpc3BsYXk6YmxvY2t9CiAgLmJ0bnttYXJnaW4tdG9wOjIycHg7d2lkdGg6MTAwJTtib3JkZXI6bm9uZTtjdXJzb3I6cG9pbnRlcjtmb250LWZhbWlseTonQnJpY29sYWdlIEdyb3Rlc3F1ZScsc2Fucy1zZXJpZjtmb250LXdlaWdodDo3MDA7Zm9udC1zaXplOjE2cHg7Y29sb3I6IzFhMGQwOTtiYWNrZ3JvdW5kOmxpbmVhci1ncmFkaWVudCgxMzVkZWcsdmFyKC0tYWNjZW50KSx2YXIoLS1hY2NlbnQyKSk7cGFkZGluZzoxNXB4O2JvcmRlci1yYWRpdXM6MTJweDt0cmFuc2l0aW9uOnRyYW5zZm9ybSAuMTJzLGJveC1zaGFkb3cgLjEycztib3gtc2hhZG93OjAgOHB4IDI0cHggcmdiYSgyNTUsODQsNTQsLjMpO2Rpc3BsYXk6ZmxleDthbGlnbi1pdGVtczpjZW50ZXI7anVzdGlmeS1jb250ZW50OmNlbnRlcjtnYXA6OXB4fQogIC5idG46aG92ZXJ7dHJhbnNmb3JtOnRyYW5zbGF0ZVkoLTFweCk7Ym94LXNoYWRvdzowIDEycHggMzBweCByZ2JhKDI1NSw4NCw1NCwuNDIpfQogIC5idG46ZGlzYWJsZWR7b3BhY2l0eTouNTtjdXJzb3I6bm90LWFsbG93ZWQ7dHJhbnNmb3JtOm5vbmV9CiAgLmhpbnR7Zm9udC1zaXplOjEzcHg7Y29sb3I6dmFyKC0tZmFpbnQpO21hcmdpbi10b3A6MTRweDtsaW5lLWhlaWdodDoxLjZ9CiAgLnN0YXR1c3ttYXJnaW4tdG9wOjIycHg7dGV4dC1hbGlnbjpjZW50ZXI7Zm9udC1zaXplOjE0LjVweDtjb2xvcjp2YXIoLS1tdXRlZCl9CiAgLnNwaW5uZXJ7ZGlzcGxheTppbmxpbmUtYmxvY2s7d2lkdGg6MTZweDtoZWlnaHQ6MTZweDtib3JkZXI6MnB4IHNvbGlkIHZhcigtLWxpbmUpO2JvcmRlci10b3AtY29sb3I6dmFyKC0tYWNjZW50KTtib3JkZXItcmFkaXVzOjUwJTthbmltYXRpb246c3BpbiAuOHMgbGluZWFyIGluZmluaXRlO3ZlcnRpY2FsLWFsaWduOi0zcHg7bWFyZ2luLXJpZ2h0OjhweH0KICBAa2V5ZnJhbWVzIHNwaW57dG97dHJhbnNmb3JtOnJvdGF0ZSgzNjBkZWcpfX0KICAuZXJye21hcmdpbi10b3A6MjBweDtiYWNrZ3JvdW5kOnJnYmEoMjU1LDEwNiw5MCwuMSk7Ym9yZGVyOjFweCBzb2xpZCByZ2JhKDI1NSwxMDYsOTAsLjQpO2NvbG9yOiNmZmIzYWE7cGFkZGluZzoxNHB4IDE2cHg7Ym9yZGVyLXJhZGl1czoxMnB4O2ZvbnQtc2l6ZToxNHB4fQogIC5va3ttYXJnaW4tdG9wOjIycHg7YmFja2dyb3VuZDpyZ2JhKDYxLDIyMCwxMzIsLjA4KTtib3JkZXI6MXB4IHNvbGlkIHJnYmEoNjEsMjIwLDEzMiwuMzUpO2JvcmRlci1yYWRpdXM6MTRweDtwYWRkaW5nOjIwcHg7dGV4dC1hbGlnbjpjZW50ZXJ9CiAgLm9rIHB7bWFyZ2luOjAgMCAxNHB4O2NvbG9yOnZhcigtLWdvb2QpO2ZvbnQtd2VpZ2h0OjYwMH0KICAub2sgYXtkaXNwbGF5OmlubGluZS1ibG9jaztiYWNrZ3JvdW5kOnZhcigtLWdvb2QpO2NvbG9yOiMwNjIwMTM7Zm9udC13ZWlnaHQ6NzAwO2ZvbnQtZmFtaWx5OidCcmljb2xhZ2UgR3JvdGVzcXVlJyxzYW5zLXNlcmlmO3RleHQtZGVjb3JhdGlvbjpub25lO3BhZGRpbmc6MTJweCAyMnB4O2JvcmRlci1yYWRpdXM6MTFweH0KICBmb290ZXJ7bWFyZ2luLXRvcDo0MHB4O3RleHQtYWxpZ246Y2VudGVyO2NvbG9yOnZhcigtLWZhaW50KTtmb250LXNpemU6MTJweH0KPC9zdHlsZT4KPC9oZWFkPgo8Ym9keT4KPGRpdiBjbGFzcz0id3JhcCI+CiAgPGhlYWRlcj4KICAgIDxkaXYgY2xhc3M9ImxvZ28iPgogICAgICA8c3ZnIHdpZHRoPSIyNCIgaGVpZ2h0PSIyNCIgdmlld0JveD0iMCAwIDI0IDI0IiBmaWxsPSJub25lIiBzdHJva2U9IiMxYTBkMDkiIHN0cm9rZS13aWR0aD0iMi4yIiBzdHJva2UtbGluZWNhcD0icm91bmQiIHN0cm9rZS1saW5lam9pbj0icm91bmQiPjxjaXJjbGUgY3g9IjYiIGN5PSI2IiByPSIzIi8+PGNpcmNsZSBjeD0iNiIgY3k9IjE4IiByPSIzIi8+PGxpbmUgeDE9IjIwIiB5MT0iNCIgeDI9IjguMTIiIHkyPSIxNS44OCIvPjxsaW5lIHgxPSIxNC40NyIgeTE9IjE0LjQ4IiB4Mj0iMjAiIHkyPSIyMCIvPjxsaW5lIHgxPSI4LjEyIiB5MT0iOC4xMiIgeDI9IjEyIiB5Mj0iMTIiLz48L3N2Zz4KICAgIDwvZGl2PgogICAgPGRpdj48aDE+Q29ydGFkb3I8L2gxPjxwIGNsYXNzPSJzdWIiPkNvbGEgbyBsaW5rLCBlc2NvbGhlIG8gdHJlY2hvLCBiYWl4YSBvIGNvcnRlLjwvcD48L2Rpdj4KICA8L2hlYWRlcj4KCiAgPGRpdiBjbGFzcz0iY2FyZCI+CiAgICA8bGFiZWwgZm9yPSJ1cmwiPkxpbmsgZG8gdsOtZGVvIG5vIFlvdVR1YmU8L2xhYmVsPgogICAgPGlucHV0IGlkPSJ1cmwiIHR5cGU9InRleHQiIHBsYWNlaG9sZGVyPSJodHRwczovL3lvdXR1YmUuY29tL3dhdGNoP3Y9Li4uIj4KICAgIDxkaXYgY2xhc3M9InRpbWVzIj4KICAgICAgPGRpdj48bGFiZWwgZm9yPSJpbmkiPkRvIG1pbnV0bzwvbGFiZWw+PGlucHV0IGlkPSJpbmkiIHR5cGU9InRleHQiIHBsYWNlaG9sZGVyPSI0OjMyIj48L2Rpdj4KICAgICAgPGRpdj48bGFiZWwgZm9yPSJmaW0iPkF0w6kgbyBtaW51dG88L2xhYmVsPjxpbnB1dCBpZD0iZmltIiB0eXBlPSJ0ZXh0IiBwbGFjZWhvbGRlcj0iNjoxMCI+PC9kaXY+CiAgICA8L2Rpdj4KICAgIDxkaXYgY2xhc3M9ImZvcm1hdG8tYmxvY28iPgogICAgICA8bGFiZWwgZm9yPSJmb3JtYXRvIj5Gb3JtYXRvPC9sYWJlbD4KICAgICAgPHNlbGVjdCBpZD0iZm9ybWF0byIgb25jaGFuZ2U9ImF0dWFsaXphclRleHRvQmxvY28oKSI+CiAgICAgICAgPG9wdGlvbiB2YWx1ZT0ib3JpZ2luYWwiPk9yaWdpbmFsIChob3Jpem9udGFsLCBpZ3VhbCBhIGF1bGEpPC9vcHRpb24+CiAgICAgICAgPG9wdGlvbiB2YWx1ZT0iY2VudHJvX2JsdXIiPlNob3J0czogQ2VudHJvICsgZnVuZG8gZGVzZm9jYWRvPC9vcHRpb24+CiAgICAgICAgPG9wdGlvbiB2YWx1ZT0iY3JvcCI+U2hvcnRzOiBDcm9wIGNlbnRyYWwgKHpvb20gbm8gbWVpbyk8L29wdGlvbj4KICAgICAgICA8b3B0aW9uIHZhbHVlPSJ0YWxraW5nX3RleHRvIj5TaG9ydHM6IFRhbGtpbmcgaGVhZCArIHRleHRvIGVtYmFpeG88L29wdGlvbj4KICAgICAgPC9zZWxlY3Q+CiAgICA8L2Rpdj4KICAgIDxkaXYgY2xhc3M9InRleHRvLWJsb2NvIiBpZD0idGV4dG8tYmxvY28iPgogICAgICA8bGFiZWwgZm9yPSJ0ZXh0byI+VGV4dG8gcXVlIHZhaSBhcGFyZWNlciBlbWJhaXhvPC9sYWJlbD4KICAgICAgPGlucHV0IGlkPSJ0ZXh0byIgdHlwZT0idGV4dCIgbWF4bGVuZ3RoPSI4MCIgcGxhY2Vob2xkZXI9IkVYOiBFTEUgUVVFUiBBTEdVRU0gUVVFIj4KICAgICAgPHAgY2xhc3M9ImhpbnQiIHN0eWxlPSJtYXJnaW4tdG9wOjZweCI+QXTDqSA4MCBjYXJhY3RlcmVzLiBWYWkgYXBhcmVjZXIgZW0gbWFpw7pzY3VsYXMsIGZvbnRlIGdyb3NzYSBicmFuY2EuPC9wPgogICAgPC9kaXY+CiAgICA8YnV0dG9uIGNsYXNzPSJidG4iIGlkPSJnbyIgb25jbGljaz0iY29ydGFyKCkiPgogICAgICA8c3ZnIHdpZHRoPSIxOCIgaGVpZ2h0PSIxOCIgdmlld0JveD0iMCAwIDI0IDI0IiBmaWxsPSJub25lIiBzdHJva2U9IiMxYTBkMDkiIHN0cm9rZS13aWR0aD0iMi40IiBzdHJva2UtbGluZWNhcD0icm91bmQiIHN0cm9rZS1saW5lam9pbj0icm91bmQiPjxjaXJjbGUgY3g9IjYiIGN5PSI2IiByPSIzIi8+PGNpcmNsZSBjeD0iNiIgY3k9IjE4IiByPSIzIi8+PGxpbmUgeDE9IjIwIiB5MT0iNCIgeDI9IjguMTIiIHkyPSIxNS44OCIvPjxsaW5lIHgxPSIxNC40NyIgeTE9IjE0LjQ4IiB4Mj0iMjAiIHkyPSIyMCIvPjwvc3ZnPgogICAgICBDb3J0YXIgZSBiYWl4YXIKICAgIDwvYnV0dG9uPgogICAgPHAgY2xhc3M9ImhpbnQiPkVzY3JldmUgbyB0ZW1wbyBhc3NpbTogPGI+NDozMjwvYj4gKG1pbnV0byBlIHNlZ3VuZG8pLiBTZSBwYXNzYXIgZGUgdW1hIGhvcmEsIHVzYSA8Yj4xOjA0OjEwPC9iPi4gUHJhIFNob3J0czogaWRlYWwgY29ydGFyIGF0w6kgNjBzLjwvcD4KICA8L2Rpdj4KCiAgPGRpdiBpZD0ic3RhdHVzIj48L2Rpdj4KCiAgPGZvb3Rlcj5Db3J0YWRvciDCtyBJbnN0cnVjdGl2YTwvZm9vdGVyPgo8L2Rpdj4KCjxzY3JpcHQ+CmNvbnN0IEFQSSA9ICIiOwpjb25zdCAkID0gaWQgPT4gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoaWQpOwoKZnVuY3Rpb24gYXR1YWxpemFyVGV4dG9CbG9jbygpewogIGNvbnN0IGYgPSAkKCdmb3JtYXRvJykudmFsdWU7CiAgJCgndGV4dG8tYmxvY28nKS5jbGFzc0xpc3QudG9nZ2xlKCdzaG93JywgZiA9PT0gJ3RhbGtpbmdfdGV4dG8nKTsKfQoKYXN5bmMgZnVuY3Rpb24gY29ydGFyKCl7CiAgY29uc3QgdXJsID0gJCgndXJsJykudmFsdWUudHJpbSgpOwogIGNvbnN0IGluaWNpbyA9ICQoJ2luaScpLnZhbHVlLnRyaW0oKTsKICBjb25zdCBmaW0gPSAkKCdmaW0nKS52YWx1ZS50cmltKCk7CiAgY29uc3QgZm9ybWF0byA9ICQoJ2Zvcm1hdG8nKS52YWx1ZTsKICBjb25zdCB0ZXh0byA9ICQoJ3RleHRvJykudmFsdWUudHJpbSgpOwogICQoJ3N0YXR1cycpLmlubmVySFRNTCA9ICcnOwoKICBpZighdXJsKXsgZXJybygnQ29sYSBvIGxpbmsgZG8gdmlkZW8uJyk7IHJldHVybjsgfQogIGlmKCFpbmljaW8gfHwgIWZpbSl7IGVycm8oJ1ByZWVuY2hlIG8gbWludXRvIGRlIGluaWNpbyBlIGRlIGZpbS4nKTsgcmV0dXJuOyB9CiAgaWYoZm9ybWF0byA9PT0gJ3RhbGtpbmdfdGV4dG8nICYmICF0ZXh0byl7IGVycm8oJ1ByYSBlc3NlIGZvcm1hdG8sIHByZWVuY2hlIG8gdGV4dG8gcXVlIHZhaSBhcGFyZWNlciBlbWJhaXhvLicpOyByZXR1cm47IH0KCiAgJCgnZ28nKS5kaXNhYmxlZCA9IHRydWU7CiAgY29uc3QgbXNnRm9ybWF0byA9IGZvcm1hdG8gPT09ICdvcmlnaW5hbCcgPyAnQ29ydGFuZG8gbyB0cmVjaG8uLi4nIDogJ0NvcnRhbmRvIGUgZ2VyYW5kbyBTaG9ydHMgdmVydGljYWwgKHBvZGUgbGV2YXIgdW5zIDIwcykuLi4nOwogICQoJ3N0YXR1cycpLmlubmVySFRNTCA9ICc8ZGl2IGNsYXNzPSJzdGF0dXMiPjxzcGFuIGNsYXNzPSJzcGlubmVyIj48L3NwYW4+Jyttc2dGb3JtYXRvKyc8L2Rpdj4nOwoKICB0cnl7CiAgICBjb25zdCByZXMgPSBhd2FpdCBmZXRjaChBUEkgKyAnL2NvcnRhcicsIHsKICAgICAgbWV0aG9kOidQT1NUJywKICAgICAgaGVhZGVyczp7J0NvbnRlbnQtVHlwZSc6J2FwcGxpY2F0aW9uL2pzb24nfSwKICAgICAgYm9keTogSlNPTi5zdHJpbmdpZnkoeyB1cmwsIGluaWNpbywgZmltLCBmb3JtYXRvLCB0ZXh0byB9KQogICAgfSk7CiAgICBjb25zdCB0aXBvID0gcmVzLmhlYWRlcnMuZ2V0KCdjb250ZW50LXR5cGUnKSB8fCAnJzsKICAgIGlmKHRpcG8uaW5jbHVkZXMoJ2FwcGxpY2F0aW9uL2pzb24nKSl7CiAgICAgIGNvbnN0IGogPSBhd2FpdCByZXMuanNvbigpOwogICAgICBlcnJvKGouZXJybyB8fCAnTmFvIGNvbnNlZ3VpIGNvcnRhciBlc3NlIHZpZGVvLicsIGouZGV0YWxoZSk7CiAgICAgIHJldHVybjsKICAgIH0KICAgIGNvbnN0IGJsb2IgPSBhd2FpdCByZXMuYmxvYigpOwogICAgY29uc3QgbGluayA9IFVSTC5jcmVhdGVPYmplY3RVUkwoYmxvYik7CiAgICBjb25zdCBzdWZpeG8gPSBmb3JtYXRvID09PSAnb3JpZ2luYWwnID8gJycgOiAnXycgKyBmb3JtYXRvOwogICAgY29uc3Qgbm9tZSA9IGBjb3J0ZV8ke2luaWNpby5yZXBsYWNlKC86L2csJy0nKX1fYV8ke2ZpbS5yZXBsYWNlKC86L2csJy0nKX0ke3N1Zml4b30ubXA0YDsKICAgIGNvbnN0IGEgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdhJyk7CiAgICBhLmhyZWYgPSBsaW5rOyBhLmRvd25sb2FkID0gbm9tZTsgZG9jdW1lbnQuYm9keS5hcHBlbmRDaGlsZChhKTsgYS5jbGljaygpOyBhLnJlbW92ZSgpOwogICAgJCgnc3RhdHVzJykuaW5uZXJIVE1MID0gYDxkaXYgY2xhc3M9Im9rIj48cD7inJMgQ29ydGUgcHJvbnRvISBPIGRvd25sb2FkIGNvbWXDp291LjwvcD48YSBocmVmPSIke2xpbmt9IiBkb3dubG9hZD0iJHtub21lfSI+QmFpeGFyIGRlIG5vdm88L2E+PC9kaXY+YDsKICB9Y2F0Y2goZSl7CiAgICBlcnJvKCdOYW8gY29uc2VndWkgZmFsYXIgY29tIG8gc2Vydmlkb3IuIENvbmZlcmUgc2UgbyBSYWlsd2F5IHRhIG5vIGFyLiAoJysgZS5tZXNzYWdlICsnKScpOwogIH1maW5hbGx5ewogICAgJCgnZ28nKS5kaXNhYmxlZCA9IGZhbHNlOwogIH0KfQpmdW5jdGlvbiBlcnJvKG1zZywgZGV0YWxoZSl7CiAgbGV0IGggPSAnPGRpdiBjbGFzcz0iZXJyIj4nICsgbXNnOwogIGlmKGRldGFsaGUpeyBoICs9ICc8ZGl2IHN0eWxlPSJtYXJnaW4tdG9wOjEwcHg7Zm9udC1zaXplOjExLjVweDtjb2xvcjojYzlhMDhlO3doaXRlLXNwYWNlOnByZS13cmFwO2ZvbnQtZmFtaWx5Om1vbm9zcGFjZTtsaW5lLWhlaWdodDoxLjUiPicgKyBTdHJpbmcoZGV0YWxoZSkucmVwbGFjZSgvWyY8Pl0vZyxjPT4oeycmJzonJmFtcDsnLCc8JzonJmx0OycsJz4nOicmZ3Q7J31bY10pKSArICc8L2Rpdj4nOyB9CiAgaCArPSAnPC9kaXY+JzsKICAkKCdzdGF0dXMnKS5pbm5lckhUTUwgPSBoOwp9Cjwvc2NyaXB0Pgo8L2JvZHk+CjwvaHRtbD4K", 'base64').toString('utf8');

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

// ---- Baixa fonte Anton (usada pra texto em Shorts) ----
const FONTE = path.join(os.tmpdir(), 'Anton-Regular.ttf');
const FONTE_URL = 'https://github.com/google/fonts/raw/main/ofl/anton/Anton-Regular.ttf';
let prontoFonte = null;
function garantirFonte() {
  if (prontoFonte) return prontoFonte;
  prontoFonte = new Promise((resolve, reject) => {
    if (fs.existsSync(FONTE)) return resolve();
    const baixar = (url) => {
      https.get(url, (r) => {
        if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location) return baixar(r.headers.location);
        if (r.statusCode !== 200) return reject(new Error('Nao consegui baixar a fonte (' + r.statusCode + ')'));
        const out = fs.createWriteStream(FONTE);
        r.pipe(out);
        out.on('finish', () => out.close(() => { console.log('[cortador] fonte Anton pronta'); resolve(); }));
        out.on('error', reject);
      }).on('error', reject);
    };
    baixar(FONTE_URL);
  });
  return prontoFonte;
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
app.get('/status', (_req, res) => {
  let videosCacheados = 0;
  try { if (fs.existsSync(CACHE_DIR)) videosCacheados = fs.readdirSync(CACHE_DIR).length; } catch (e) {}
  res.json({ ok: true, servico: 'cortador', versao: 31, cookies: cookiesOk, proxy: PROXY_URL ? (process.env.PROXY_HOST + ':' + process.env.PROXY_PORT) : false, videosNoCache: videosCacheados });
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
  const formato = String(req.body.formato || 'original').trim();
  const texto = String(req.body.texto || '').trim().slice(0, 80);

  if (!linkValido(url)) return res.status(400).json({ erro: 'Cole um link valido do YouTube.' });
  if (!tempoValido(inicio) || !tempoValido(fim)) return res.status(400).json({ erro: 'Use o formato de tempo certo, tipo 4:32 ou 1:04:10.' });
  if (!['original', 'centro_blur', 'crop', 'talking_texto'].includes(formato)) return res.status(400).json({ erro: 'Formato invalido.' });

  const si = paraSegundos(inicio), sf = paraSegundos(fim);
  if (isNaN(si) || isNaN(sf) || sf <= si) return res.status(400).json({ erro: 'O fim precisa ser depois do inicio.' });
  if (sf - si > MAX_SEGUNDOS) return res.status(400).json({ erro: 'O corte ta muito longo (maximo 60 minutos por vez).' });

  let pasta;
  try {
    await garantirYtdlp();
    await garantirFfmpeg();
    if (formato === 'talking_texto') await garantirFonte();
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    limparCacheAntigo();
    pasta = fs.mkdtempSync(path.join(os.tmpdir(), 'corte-'));
    const fullPath = cachePathPara(url, 'mp4');
    const cortePath = path.join(pasta, 'corte.mp4');
    const duracao = sf - si;
    const cacheHit = fs.existsSync(fullPath) && (() => { try { return fs.statSync(fullPath).size > 1024 * 1024; } catch (e) { return false; } })();

    if (cacheHit) {
      console.log('[cortador] CACHE HIT - usando video ja baixado:', path.basename(fullPath));
    } else {
      const t1 = Date.now();
      console.log('[cortador] CACHE MISS - baixando do YouTube | proxy:', PROXY_URL ? 'sim' : 'nao');
      const r1 = await executar(YTDLP, [
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
      const dt1 = ((Date.now() - t1) / 1000).toFixed(1);
      console.log('[cortador] download levou', dt1, 's');

      if (r1.codigo !== 0 || !fs.existsSync(fullPath)) {
        try { if (fs.existsSync(fullPath)) fs.unlinkSync(fullPath); } catch (e) {}
        limpar(pasta);
        return res.status(500).json({ erro: 'Nao consegui baixar esse video. Confere o link.', detalhe: (r1.stderr || r1.stdout || 'sem detalhes').slice(-600) });
      }
    }

    const t2 = Date.now();
    console.log('[cortador] cortando | formato', formato, '| inicio', si, 's | duracao', duracao, 's');

    let cutArgs;
    if (formato === 'original') {
      // -c copy: cut rapido sem reencode (segundos)
      cutArgs = [
        '-y',
        '-ss', String(si),
        '-i', fullPath,
        '-t', String(duracao),
        '-c', 'copy',
        '-avoid_negative_ts', 'make_zero',
        cortePath,
      ];
    } else {
      // Formatos verticais: reencode com filtro
      let filtroV;
      if (formato === 'centro_blur') {
        // Vídeo no centro com fundo desfocado
        filtroV = 'split=2[a][b];[a]scale=720:1280:force_original_aspect_ratio=increase,crop=720:1280,boxblur=20:1[bg];[b]scale=720:-1[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2';
      } else if (formato === 'crop') {
        // Crop central, zoom no meio
        filtroV = 'crop=ih*9/16:ih,scale=720:1280';
      } else { // talking_texto
        // Crop + texto via subtitles ASS (drawtext nao disponivel no build do ffmpeg)
        // libass renderiza com fontes apontadas via fontsdir
        const assPath = path.join(pasta, 'texto.ass');
        const textoUp = (texto || 'INSTRUCTIVA').toUpperCase().replace(/[\\{}]/g, '');
        const assConteudo = `[Script Info]
ScriptType: v4.00+
PlayResX: 720
PlayResY: 1280
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Anton,62,&H00FFFFFF,&H00FFFFFF,&H00000000,&HA0000000,1,0,0,0,100,100,0,0,3,4,1,2,30,30,140,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:00.00,9:00:00.00,Default,,0,0,0,,${textoUp}
`;
        fs.writeFileSync(assPath, assConteudo);
        // Escapar : e , no path da subtitles filter pra ffmpeg
        const assPathEscaped = assPath.replace(/\\/g, '/').replace(/:/g, '\\\\:').replace(/,/g, '\\,');
        const fontsDir = path.dirname(FONTE);
        filtroV = `crop=ih*9/16:ih,scale=720:1280,subtitles='${assPathEscaped}':fontsdir='${fontsDir}'`;
      }
      cutArgs = [
        '-y',
        '-ss', String(si),
        '-i', fullPath,
        '-t', String(duracao),
        '-vf', filtroV,
        '-c:v', 'libx264',
        '-preset', 'ultrafast',
        '-crf', '23',
        '-c:a', 'aac',
        '-b:a', '128k',
        '-movflags', '+faststart',
        cortePath,
      ];
    }

    const r2 = await executar(FFMPEG, cutArgs, 'ffmpeg-cut');
    const dt2 = ((Date.now() - t2) / 1000).toFixed(1);
    console.log('[cortador] cut levou', dt2, 's | cache:', cacheHit ? 'HIT' : 'MISS', '| formato:', formato);

    if (r2.codigo !== 0 || !fs.existsSync(cortePath)) {
      limpar(pasta);
      return res.status(500).json({ erro: 'Baixei o video mas nao consegui cortar.', detalhe: (r2.stderr || 'sem detalhes').slice(-600) });
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
