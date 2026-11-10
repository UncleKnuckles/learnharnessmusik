# LearnHarness для музыки (форк)

Форк [amosblomqvist/learnharness](https://github.com/amosblomqvist/learnharness) для изучения теории музыки: Formenlehre, Funktionstheorie, Tonsatz, каденции, немецкоязычные скрипты и их русские переводы.

## Что добавлено

### Импорт в граф («Extract files…»)

- **PDF, Markdown, TXT.** Лимит размера поднят с 25 МБ до 2 ГБ на файл (это практический потолок одной загрузки в память). Лимит в 1000 страниц PDF снят.
- **Картинки PNG, JPEG, WebP.** Vision-модель (слот *Vision* в Settings → Models) переписывает страницу в Markdown: текст, нотные примеры словами, функциональные обозначения (T, S, D, Tp, D7, DD …), цифровки, номера тактов, таблицы. Дальше текст идёт в граф обычным путём. Нотацию после распознавания стоит проверить.
- **Аудио MP3, WAV, M4A, AAC, OGG, OPUS, FLAC, WebM.** Расшифровка идёт через Deepgram (pre-recorded API, модель nova-3, язык определяется автоматически), нужен ключ Deepgram в Settings → Keys. Handy аудиофайлы не принимает, он работает только как живая диктовка.
- **Без дублей.** Файл, который уже успешно импортирован и с тех пор не менялся (тот же путь и то же содержимое, сравнение по SHA-256), при повторной загрузке пропускается с пометкой «Already in the graph; skipped.». Новые, изменённые и упавшие файлы обрабатываются. Если удалить источник из графа, он импортируется заново.
- **Понятная ошибка входа.** Вместо «not signed in» приложение пишет, что Claude Code не залогинен и что делать: открыть терминал, запустить `claude`, выполнить `/login` и перезапустить LearnHarness. Одинаковая ошибка больше не повторяется по разу на каждый кусок PDF.
- **Подсказки под теорию музыки.** Экстрактор сохраняет немецкие термины (с русским или английским эквивалентом, где это помогает), функциональные символы, цифровки и номера тактов в точности. Немецкую и русскую версии одного материала он считает одной мыслью. Учитель и практика получили фрагмент `shared/17-music-study.md`: немецкая терминология курса, ссылки на репертуар, задания в духе экзамена. Фрагмент можно переопределить в Settings → Agent → Prompts.

### Claude Fable 5.2

`claude-fable-5-2` есть в двух местах:

- **Claude Code** (`claude-code/claude-fable-5-2`) работает через вход в Claude Code, ключ не нужен;
- **Anthropic API** (`anthropic/claude-fable-5-2`) работает с ключом Anthropic.

Выбрать модель можно в Settings → Models для любого слота: Strong, Cheap или Vision.

### Диктовка через Handy

[Handy](https://handy.computer) — бесплатная офлайн-диктовка (Whisper/Parakeet на вашем компьютере).

1. Установите и запустите Handy (Windows: установщик с сайта или `winget install cjpais.Handy`).
2. Settings → Keys → Dictation → **Engine**. Варианты: `Auto` (Deepgram, если есть ключ, иначе Handy), `Deepgram` или `Handy`.
3. Кнопка **Dictate** (или ⌘/Ctrl+D) запускает запись в Handy, **Stop** останавливает её. Handy сам вставит текст в поле ввода.

Собственный хоткей Handy тоже работает: поставьте курсор в поле ввода LearnHarness и диктуйте. Если Handy установлен в нестандартное место, укажите путь к нему в переменной `LH_HANDY_PATH`.

## CLI `learnharness`

CLI работает с запущенным приложением: тот же граф, те же модели и настройки. Десктоп-приложение пишет адрес и секрет в `%APPDATA%\LearnHarness\local-api.json` (macOS: `~/Library/Application Support/LearnHarness/`), а CLI читает их оттуда.

```bash
git clone https://github.com/UncleKnuckles/learnharnessmusik
cd learnharnessmusik
npm install
npm link            # команда learnharness станет доступна везде (или: node cli/learnharness.mjs …)

learnharness status
learnharness models                 # ★ отмечает Claude Fable
learnharness search Trugschluss
learnharness node n_abc123
learnharness import "D:\Musik\Formenlehre"      # папка: PDF, картинки, аудио, md
learnharness ask "Чем Periode отличается от Satz?"            # по умолчанию Fable 5.2
learnharness ask --model opus --effort medium "Was ist ein Trugschluss?"
learnharness doctor                 # проверка входа в Claude Code
```

`ask` вызывает `claude -p --model claude-fable-5-2` через ваш вход в Claude Code и подкладывает в контекст подходящие идеи из графа.

## MCP-сервер

`learnharness mcp` запускает MCP-сервер через stdio. Он даёт инструменты `graph_overview`, `search_ideas`, `get_idea`, `list_sessions`, `import_files`, `list_models` и `ask_tutor` (отвечает Fable 5.2).

Claude Desktop (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "learnharness": {
      "command": "node",
      "args": ["C:\\path\\to\\learnharnessmusik\\cli\\learnharness.mjs", "mcp"]
    }
  }
}
```

Claude Code:

```bash
claude mcp add learnharness -- node C:\path\to\learnharnessmusik\cli\learnharness.mjs mcp
```

LearnHarness при этом должен быть запущен.

## Сборка для Windows

GitHub → Actions → **Windows installer (music fork)** → *Run workflow*. Когда сборка закончится, установщик `LearnHarness-Setup-*.exe` появится в артефактах запуска. Обновления форка берутся из релизов `UncleKnuckles/learnharnessmusik`, поэтому релизы оригинала его не перезапишут.

Данные (граф, сессии, ключи) лежат в `%APPDATA%\LearnHarness` и не зависят от версии кода, так что после установки форка всё сохраняется.
