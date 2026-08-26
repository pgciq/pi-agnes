# pi-agnes

Pi extension for [Agnes AI](https://agnes-ai.com), with dynamic model discovery and support for both Agnes endpoints.

## Install

```bash
pi install npm:pi-agnes
```

Or install from git:

```bash
pi install git:github.com/pgciq/pi-agnes
```

## Configuration

Set the API key for the endpoint you want to use:

| Provider | Endpoint | Environment variable |
|---|---|---|
| `agnes` | `https://apihub.agnes-ai.com/v1` | `AGNES_API_KEY` |
| `agnes-cn` | `https://api.agnes-ai.cn/v1` | `AGNES_CN_API_KEY` |

The extension starts with a seed model catalog and refreshes it from `/v1/models` in the background. A successful catalog refresh is persisted for offline starts.

## Usage

```bash
pi --model agnes/agnes-2.5-flash "你好"
pi --model agnes-cn/agnes-2.5-pro "你好"
```
