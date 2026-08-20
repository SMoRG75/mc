# Mainframe Commander

Total Commander-agtig dual-pane filhåndtering til z/OS, som en VS Code-extension.
Forbindelsen går gennem [Zowe](https://www.zowe.org/), så brugerens eksisterende
`zowe.config.json` — inklusive certifikater, MFA og credential manager — er den
eneste opsætning der kræves.

Designskitsen ligger i [`docs/mainframe-commander-mockup.html`](docs/mainframe-commander-mockup.html).

## Kom i gang

```bash
npm install
npm run build          # eller: npm run watch
```

Tryk `F5` i VS Code for at starte en Extension Development Host, og kør
kommandoen **Mainframe Commander: Open** (`Ctrl+Shift+M`).

`npm run typecheck` kører TypeScript over både extension- og webview-halvdelen.

## Sådan hænger det sammen

```
src/
├─ extension.ts            Aktivering: registrerer providers, kommandoer og filsystem
├─ commanderPanel.ts       Webview-panelet og al tilstand (hvor peger panelerne hen)
├─ shared/
│  └─ protocol.ts          Beskedkontrakten mellem host og webview — importeres af begge
├─ core/
│  ├─ provider.ts          PaneProvider-interfacet + registry
│  ├─ transferQueue.ts     Baggrundskø for F5/F6 med samtidighed og annullering
│  ├─ editorBridge.ts      FileSystemProvider, så F3/F4 åbner i en rigtig editor
│  ├─ text.ts              Tekst/binær-valg og LRECL-tilpasning
│  ├─ settings.ts          Typet læsning af mc.*-indstillingerne
│  └─ errors.ts            Graver den læsbare sætning ud af z/OSMF-fejl
├─ providers/
│  ├─ localProvider.ts     Lokal disk
│  ├─ dsProvider.ts        MVS: datasetfilter, PDS-medlemmer, allokering, submit
│  ├─ ussProvider.ts       USS: stier, rettigheder, tagging
│  └─ jesProvider.ts       JES: jobs som mapper, spool-DD'er som filer
└─ zowe/
   └─ sessions.ts          ProfileInfo → session, cachet pr. profilnavn

webview/
├─ index.ts                App: layout, beskeder, handlinger
├─ pane.ts                 Ét panel: header, sti, rækker, footer, markering
├─ virtualList.ts          Vinduesrendering — kun synlige rækker bygges
├─ keymap.ts               Tast → handling, med dedup af videresendte taster
├─ dialogs.ts              F5-overførselsdialogen, prompt, bekræft
└─ style.css               Total Commander-layout i brugerens VS Code-tema
```

### Den bærende idé

`PaneProvider` er hele extensionen. Lokal disk, datasets, USS og JES
implementerer det samme interface, så hver tast har præcis én implementering
uanset hvilken verden panelet viser — og F5 fra LPAR1 til LPAR2 er ikke et
særtilfælde, men bare `source.read()` efterfulgt af `target.write()`.

### Beslutninger værd at kende

- **JES er et filsystem.** Jobs er mapper, spool-DD'er er filer. Derfor betyder
  F3/F5/F8 det samme dér som alle andre steder, uden en separat kommandopalette
  til jobs.
- **Filsystem-provider frem for temp-filer.** F3/F4 åbner `mc://LPAR1/BACKUP01`,
  så syntaksfarver, diff, søgning og `Ctrl+S` virker som på en lokal fil. Det
  skrivebeskyttede view bruger sit eget scheme (`mc-view`), fordi VS Code kun
  kan sætte readonly pr. provider.
- **`longLines: 'abort'` som standard.** En 132-tegns linje ned i FB 80 er den
  klassiske måde at ødelægge en upload på. Brugeren skal vælge ombryd eller
  afkort bevidst.
- **`auto` gætter kun binær på kendte endelser.** At behandle en ukendt fil som
  tekst er til at rette op på; at behandle den som binær ødelægger
  EBCDIC-konverteringen i stilhed.
- **Zowe-pakkerne bundles ikke.** Imperative loader plugins og credential
  managers med dynamiske `require()`, som en bundler ikke kan følge. De er
  markeret `external` i `esbuild.mjs` og ligger i `node_modules`.

## Status

Skelettet kompilerer og alle fire providers er skrevet mod det verificerede
Zowe v8-API. Følgende mangler før det er brugbart i praksis:

- [ ] Kørt mod en rigtig LPAR — intet her har set z/OSMF endnu
- [ ] Streaming ved store overførsler (læser og skriver hele bufferen nu)
- [ ] Rekursiv kopiering af kataloger og PDS'er
- [ ] `Alt+F7` søgning, favoritter (`Ctrl+D`), sorteringsvalg pr. kolonne
- [ ] TSO- og konsolkommandoer på kommandolinjen
- [ ] Recall af migrerede datasæt (vises, men afvises pt.)
- [ ] Tests

## Licens

EPL-2.0, som resten af Zowe-økosystemet.
