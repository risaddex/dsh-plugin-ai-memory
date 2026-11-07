# Third-party attribution

## ai-memory hook bundle (vendored verbatim)

The lifecycle hook scripts under `assets/hooks/` are copied unchanged from the
ai-memory project so that this plugin runs **the hooks ai-memory itself
proposes for DeepSeek Harness**, not a reimplementation of them:

| Vendored file | Upstream path |
|---|---|
| `assets/hooks/_lib.sh` | [`hooks/_lib.sh`](https://github.com/akitaonrails/ai-memory/blob/main/hooks/_lib.sh) |
| `assets/hooks/dsh/session-start.sh` | [`hooks/dsh/session-start.sh`](https://github.com/akitaonrails/ai-memory/blob/main/hooks/dsh/session-start.sh) |
| `assets/hooks/dsh/user-prompt-submit.sh` | [`hooks/dsh/user-prompt-submit.sh`](https://github.com/akitaonrails/ai-memory/blob/main/hooks/dsh/user-prompt-submit.sh) |
| `assets/hooks/dsh/pre-tool-use.sh` | [`hooks/dsh/pre-tool-use.sh`](https://github.com/akitaonrails/ai-memory/blob/main/hooks/dsh/pre-tool-use.sh) |
| `assets/hooks/dsh/post-tool-use.sh` | [`hooks/dsh/post-tool-use.sh`](https://github.com/akitaonrails/ai-memory/blob/main/hooks/dsh/post-tool-use.sh) |
| `assets/hooks/dsh/stop.sh` | [`hooks/dsh/stop.sh`](https://github.com/akitaonrails/ai-memory/blob/main/hooks/dsh/stop.sh) |
| `assets/hooks/dsh/subagent-start.sh` | [`hooks/dsh/subagent-start.sh`](https://github.com/akitaonrails/ai-memory/blob/main/hooks/dsh/subagent-start.sh) |
| `assets/hooks/dsh/subagent-stop.sh` | [`hooks/dsh/subagent-stop.sh`](https://github.com/akitaonrails/ai-memory/blob/main/hooks/dsh/subagent-stop.sh) |

Upstream project: <https://github.com/akitaonrails/ai-memory> — MIT License,
Copyright (c) 2026 Fabio Akita.

```
MIT License

Copyright (c) 2026 Fabio Akita

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### Updating the bundle

Re-copy the files (no local edits — keep the diff byte-trivial so upstream
changes stay easy to audit):

```bash
git clone --depth 1 --filter=blob:none --sparse https://github.com/akitaonrails/ai-memory /tmp/ai-memory
cd /tmp/ai-memory && git sparse-checkout set hooks
cp hooks/_lib.sh                      <plugin>/assets/hooks/_lib.sh
cp hooks/dsh/*.sh                     <plugin>/assets/hooks/dsh/
chmod 755 <plugin>/assets/hooks/dsh/*.sh
```

Then bump `version` in `package.json` and reload the plugin (the host caches
the staged copy under `$DSH_HOME/plugins/dsh-plugin-ai-memory/hooks/dsh`, which
is rewritten on the next boot or on **Re-install hooks** in the panel).

## DeepSeek Harness

The plugin's host and browser halves follow the DSH plugin contracts shipped in
the DeepSeek Harness application (`@deepseek-ai/*` packages, MIT). No code from
those packages is copied; the sidebar/`main` slot registration and the
`connection` RPC envelope are re-implemented from their public contracts.
