# Формат экспорта FBL Visual Novel Cutscenes

Актуальная версия формата данных: `schemaVersion: 14`.

Готовый полный пример находится рядом: `examples/fbl-vn-export.example.json`. Он намеренно отформатирован с отступами для чтения, хотя обычный экспорт из модуля записывается компактным JSON без лишних пробелов и переносов строк.

## Два вида экспорта

«Экспорт катсцены» сохраняет непосредственно объект одной сцены:

```json
{
  "id": "scene-example",
  "title": "Название",
  "description": "",
  "defaultMode": "vote",
  "audioExitFadeMs": 750,
  "counters": [],
  "branches": [],
  "startFrame": "frame-start",
  "frameFolders": [],
  "graphPositions": {},
  "frames": []
}
```

«Экспорт всего» сохраняет контейнер хранилища:

```json
{
  "schemaVersion": 14,
  "version": 3,
  "scenes": [],
  "assets": [],
  "characters": []
}
```

Импорт принимает все три формы: полный контейнер, массив сцен или один объект сцены.

## Scene

Основные поля сцены:

- `id` — стабильный ID сцены.
- `title` — название.
- `description` — описание.
- `defaultMode` — `individual`, `gm` или `vote`.
- `audioExitFadeMs` — длительность плавного затухания музыки и SFX при завершении/закрытии катсцены. Хранится в миллисекундах; редактор показывает секунды.
- `counters[]` — счётчики сцены.
- `branches[]` — редакторские ветки.
- `startFrame` — ID стартового кадра.
- `frameFolders[]` — папки списка кадров.
- `graphPositions` — сохранённые координаты узлов графа, ключом является ID кадра.
- `frames[]` — кадры катсцены.

### Counter

```json
{
  "id": "counter-trust",
  "name": "Доверие",
  "initial": 0
}
```

### Branch

```json
{
  "id": "branch-main",
  "name": "Основная ветка",
  "sort": 0
}
```

### Frame folder

```json
{
  "id": "folder-main",
  "name": "Вступление",
  "branchId": "branch-main",
  "parentId": "",
  "sort": 0,
  "collapsed": false,
  "color": "#b68a4a"
}
```

## Frame

Каждый кадр содержит полный набор полей независимо от типа:

```json
{
  "id": "frame-dialogue",
  "type": "dialogue",
  "title": "Реплика",
  "branchId": "branch-main",
  "folderId": "",
  "sort": 1000,
  "isFinal": false,
  "background": "path/to/background.webp",
  "clearBackground": false,
  "transition": "none",
  "characterId": "character-guide",
  "portraitId": "portrait-guide-main",
  "speaker": "Проводник",
  "portrait": "path/to/portrait.webp",
  "hidePortrait": false,
  "portraitPosition": "auto",
  "showSpeakerName": true,
  "additionalCharacters": [],
  "vignetteMode": "none",
  "textPresentation": "box",
  "textSpeed": 160,
  "text": "Текст первого блока",
  "textBlocks": [],
  "musicCues": [],
  "sfxCues": [],
  "effectCounterId": "",
  "effectOperation": "",
  "effectValue": 0,
  "next": "",
  "nextRouting": {},
  "choices": []
}
```

Допустимые значения:

- `type`: `dialogue`, `narration`, `choice`.
- `transition`: `none`, `fade`, `dark`.
- `portraitPosition`: `auto`, `left`, `center`, `right`. `auto` наследует сторону пресета; если и пресет имеет `defaultPosition: "auto"`, диалоговые персонажи чередуются слева/справа при смене говорящего. Любая явная сторона кадра имеет приоритет.
- `vignetteMode`: `auto`, `screen`, `text`, `none`.
- `textPresentation`: `box`, `center`.
- `textSpeed`: скорость typewriter-эффекта в видимых символах в секунду, диапазон 10–500, значение по умолчанию 160.
- `effectOperation`: пустая строка, `add`, `subtract`.

Поле `text` дублирует plain-text первого элемента `textBlocks` для совместимости. При ручной генерации файла лучше держать их согласованными.

### Text block

```json
{
  "id": "text-1",
  "text": "Обычный текст",
  "richText": "<p>Обычный <strong>текст</strong></p>",
  "voice": "path/to/voice.ogg"
}
```

### Additional character

```json
{
  "id": "frame-character-1",
  "characterId": "character-companion",
  "portraitId": "portrait-companion-main",
  "name": "Спутник",
  "portrait": "path/to/companion.webp",
  "portraitPosition": "auto",
  "showName": true
}
```

### Audio cue

```json
{
  "id": "audio-1",
  "action": "play",
  "channel": "music-main",
  "src": "path/to/music.ogg",
  "loop": true,
  "repeatCount": 1,
  "repeatDelayMs": 0,
  "startDelayMs": 0,
  "fadeInMs": 1200,
  "fadeOutMs": 0,
  "crossFadeMs": 0,
  "continueRepeats": false
}
```

`action`: `play`, `stop`, `stop-all`.

Поля времени хранятся в миллисекундах, хотя редактор показывает их в секундах.

- `startDelayMs` — задержка перед запуском `play`, привязанная к исходному кадру. Если кадр сменился до окончания задержки, отложенный `PLAY` отменяется даже для `loop: true`; `continueRepeats` относится только к последующим повторам уже начатого одноразового cue.
- `fadeInMs` — плавное появление нового звука.
- `crossFadeMs` — при `play` в уже занятом канале одновременно гасит прежний звук и поднимает новый. Если канал пуст, работает как fade-in.
- `repeatCount` — общее число проигрываний одноразового звука: `1` означает один запуск. Диапазон текущей схемы: 1–20.
- `repeatDelayMs` — пауза между конечными повторами.
- `continueRepeats` — разрешает начинать следующие конечные повторы после перехода в другой кадр. По умолчанию `false`; уже начатое проигрывание может естественно закончиться.
- `fadeOutMs` — применяется к `stop` и `stop-all`.

При `loop: true` конечные повторы не используются: sanitizer приводит `repeatCount` к 1, `repeatDelayMs` к 0 и `continueRepeats` к `false`.

Пример плавной замены музыки:

```json
{
  "id": "audio-danger",
  "action": "play",
  "channel": "music-main",
  "src": "path/to/danger.ogg",
  "loop": true,
  "repeatCount": 1,
  "repeatDelayMs": 0,
  "startDelayMs": 0,
  "fadeInMs": 0,
  "fadeOutMs": 0,
  "crossFadeMs": 2000,
  "continueRepeats": false
}
```

Пример плавной остановки:

```json
{
  "id": "audio-stop",
  "action": "stop",
  "channel": "music-main",
  "src": "",
  "loop": false,
  "repeatCount": 1,
  "repeatDelayMs": 0,
  "startDelayMs": 0,
  "fadeInMs": 0,
  "fadeOutMs": 1500,
  "crossFadeMs": 0,
  "continueRepeats": false
}
```

## Условный переход кадра

```json
{
  "enabled": true,
  "conditionLogic": "and",
  "conditions": [
    {
      "id": "condition-1",
      "counterId": "counter-trust",
      "operator": "gte",
      "value": 2
    }
  ],
  "trueFrameId": "frame-success",
  "falseFrameId": "frame-fail"
}
```

`conditionLogic`: `and` или `or`.

Операторы условия: `gt`, `gte`, `eq`, `lte`, `lt`, `ne`.

## Choice

```json
{
  "id": "choice-1",
  "text": "Ответить",
  "next": "frame-next",
  "conditionLogic": "and",
  "conditions": [],
  "effectCounterId": "counter-trust",
  "effectOperation": "add",
  "effectValue": 1
}
```

Пустой `conditions` у choice означает, что вариант доступен всегда.

## Assets

```json
{
  "id": "asset-background",
  "type": "image",
  "path": "path/to/background.webp",
  "label": "Фон",
  "favorite": true,
  "lastUsed": 0
}
```

Asset library не является обязательной для воспроизведения ссылки из кадра: сами кадры хранят пути к используемым файлам непосредственно. Массив `assets` нужен библиотеке ассетов редактора.

## Characters

```json
{
  "id": "character-guide",
  "name": "Проводник",
  "defaultPosition": "auto",
  "portraits": [
    {
      "id": "portrait-guide-main",
      "label": "Основной",
      "path": "path/to/guide.webp"
    }
  ]
}
```

Кадр может ссылаться на preset через `characterId` и `portraitId`, но одновременно хранит отображаемые `speaker` и `portrait`. `defaultPosition` принимает `auto`, `left`, `center` или `right`. В режиме `auto` первый диалог после старта или недиалогового кадра появляется слева, а затем сторона меняется только при смене говорящего.

## ID и ручная генерация

ID должны быть уникальны внутри соответствующего набора и ссылки должны указывать на существующие ID. При ручной генерации удобно использовать читаемые ID вроде `frame-intro`, `choice-left`, `counter-trust`; модулю не требуется конкретный формат случайной строки.

При импорте данные проходят sanitizer и миграции. Экспорты schema v12 сначала получают поля audio timing из v13, а затем мигрируют в v14. В v14 старые неявные позиции основного портрета `left` и дополнительного `right` переводятся в `auto`, чтобы пресеты наконец могли задавать сторону; каждому старому кадру также добавляется `textSpeed: 160`. Явные `center` и противоположные стороны сохраняются. Некорректные enum-значения могут быть заменены безопасными значениями по умолчанию, а часть отсутствующих ID может быть создана автоматически. Для предсказуемого результата лучше формировать файл сразу в текущей структуре.

Полный рабочий пример всех основных сущностей: `examples/fbl-vn-export.example.json`.
