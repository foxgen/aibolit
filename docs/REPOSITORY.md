# Публикация исходников Aibolit

## Перед первым `git push`

1. Установите зависимости в корне проекта командой `npm install`. Это создаст
   `package-lock.json`, если его ещё нет. **Добавьте lock-файл в Git** — CI
   использует `npm ci`. `node_modules/` коммитить не нужно.
2. Проверьте `npm run check`, `npm test`, `npm run build`. Убедитесь,
   что `npm test` проходит полностью на вашей машине.
3. Лицензия проекта — **MIT**. Файл [`LICENSE`](../LICENSE) содержит
   `Copyright (c) 2026 Eugene Roschin`; в `package.json` указаны `author` и
   `license`. При публикации VSIX проверьте включение `LICENSE` в пакет.
4. После создания репозитория укажите фактический Git URL в поле `repository`
   файла `package.json`. До этого ссылку не следует придумывать.
5. Проверьте, что секреты, `.env`, локальные `.aibolit/`-инструкции,
   `node_modules/` и `.vsix` не попали в коммит. `.gitignore` исключает их
   по умолчанию; общие проектные инструкции при желании можно опубликовать
   отдельно осознанным решением.
6. Проверьте текст README и, если репозиторий будет публичным, включите
   GitHub Actions в настройках проекта. Workflow использует Node.js 22 и Python 3.13
   на Windows и Linux.

## Рекомендуемая последовательность (PowerShell)

```powershell
npm install
npm run check
npm test
npm run build

git init
git add .
git diff --cached --check
git diff --cached --stat
git status
git commit -m "Initial release: Aibolit 0.3.5"
```

После создания удалённого репозитория укажите его адрес через `git remote add origin ...`
и отправьте ветку. Если Git уже инициализирован — пропустите `git init`.

## Что хранится вне репозитория

Хранилище запусков находится в `ExtensionContext.storageUri`, а глобальные
инструкции — в `ExtensionContext.globalStorageUri`. Эти данные не входят в
исходный ZIP. Локальные `.aibolit/instructions.md` в текущем репозитории
игнорируются, чтобы случайно не опубликовать личные правила.

При публикации **VSIX** список включаемых файлов управляется `.vscodeignore`,
а при публикации **Git-репозитория** — `.gitignore`. Это независимые списки.
