// Game-specific glue between the static player page, locale pak chunks, and
// the synchronous PocketJS guest entry. Kept as source transforms here so no
// component/submodule patch is required.

export const WEB_LOCALE_BOOTSTRAP: Readonly<Record<string, string>> = {
  zh: "l10n/zh_CN/project-shell.json",
  de: "l10n/de_DE/project-shell.json",
  fr: "l10n/fr_FR/project-shell.json",
  es: "l10n/es_ES/project-shell.json",
  it: "l10n/it_IT/project-shell.json",
  "pt-BR": "l10n/pt_BR/project-shell.json",
};

const BROWSER_LANGUAGE_SCRIPT = `<script id="pocket-tuxemon-browser-language">
(function(){
  "use strict";
  var aliases={en:"en",zh:"zh",de:"de",fr:"fr",es:"es",it:"it",pt:"pt-BR"};
  function normalize(value){
    if(!value)return null;
    var text=String(value).replace(/_/g,"-").toLowerCase();
    if(text==="zh"||text==="zh-cn"||text==="zh-hans")return "zh";
    if(text==="pt"||text.indexOf("pt-")===0)return "pt-BR";
    var root=text.split("-")[0];
    return aliases[root]||null;
  }
  try {
    var url=new URL(location.href);
    var raw=url.searchParams.get("lang");
    var fromUrl=normalize(raw);
    if(fromUrl&&raw!==fromUrl){url.searchParams.set("lang",fromUrl);history.replaceState(null,"",url.pathname+url.search+url.hash);}
    var stored=localStorage.getItem("pocket-tuxemon/lang");
    var canonicalStored=normalize(stored);
    if(!fromUrl&&canonicalStored){if(stored!==canonicalStored)localStorage.setItem("pocket-tuxemon/lang",canonicalStored);return;}
    if(fromUrl)return;
    var candidates=(navigator.languages&&navigator.languages.length?navigator.languages:[navigator.language]);
    for(var i=0;i<candidates.length;i++){
      var detected=normalize(candidates[i]);
      if(detected){localStorage.setItem("pocket-tuxemon/lang",detected);return;}
    }
  } catch(error) {}
})();
</script>`;

/** Run browser-language canonicalization before the kit page i18n script. */
export function injectBrowserLanguageDetection(html: string): string {
  if (html.includes('id="pocket-tuxemon-browser-language"')) return html;
  const config = /<script type="application\/json" id="pocket-i18n">[\s\S]*?<\/script>/;
  if (!config.test(html)) throw new Error("web locale: player page has no pocket-i18n config");
  return html.replace(config, (match) => `${match}\n${BROWSER_LANGUAGE_SCRIPT}`);
}

/** Await the selected locale's bootstrap chunk before evaluating main.tsx. */
export function injectLocaleBootstrapBarrier(playerSource: string): string {
  if (playerSource.includes("config.localeBootstrap?.[globalThis.__pocketPageLang")) return playerSource;
  const marker = "    initAuthUI(config);\n    new Function(`${source}\\n//# sourceURL=${config.app}.js`)();";
  const replacement = "    initAuthUI(config);\n" +
    "    const localeEntry = config.localeBootstrap?.[globalThis.__pocketPageLang ?? \"en\"];\n" +
    "    if (pakChunks && localeEntry) await pakChunks.prepare(localeEntry);\n" +
    "    new Function(`${source}\\n//# sourceURL=${config.app}.js`)();";
  if (!playerSource.includes(marker)) throw new Error("web locale: player boot marker changed");
  return playerSource.replace(marker, replacement);
}
