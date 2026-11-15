"""Export this task's portable design bundle without application credentials or private reasoning."""

from __future__ import annotations

import argparse
import base64
import collections
import datetime as dt
import hashlib
import html
import json
import mimetypes
import re
import shutil
import zipfile
from pathlib import Path


def sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def write_utf8(file: Path, text: str):
    file.write_bytes(text.replace('\r\n', '\n').encode('utf-8'))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--visuals', required=True, type=Path)
    parser.add_argument('--session', required=True, type=Path)
    parser.add_argument('--skills-root', required=True, type=Path)
    parser.add_argument('--visualize-skill', required=True, type=Path)
    args = parser.parse_args()
    output = Path(__file__).resolve().parent
    source_dir = args.visuals.resolve()
    assert source_dir.is_dir() and args.session.is_file()
    created = dt.datetime.now(dt.timezone(dt.timedelta(hours=8))).isoformat()
    source = source_dir / 'requirement-modal-study.html'
    write_utf8(output / 'ui-source.html', source.read_text(encoding='utf-8'))

    wrapper = (source_dir / 'modal-preview-qa.html').read_text(encoding='utf-8')
    match = re.search(r'data-srcdoc="([^"]*)"', wrapper)
    assert match, 'Expected official preview wrapper'
    inner = html.unescape(match.group(1))
    icon_runtime = (source_dir / 'lucide-qa-runtime.js').read_text(encoding='utf-8')
    inner, replaced = re.subn(r'<script\b[^>]*\bsrc="https://unpkg\.com/lucide[^\"]*"[^>]*>\s*</script>', lambda _: '<script>' + icon_runtime.replace('</script', '<\\/script') + '</script>', inner)
    assert replaced == 1, 'Icon runtime was not embedded'
    for component, version in [('core', '1.7.3'), ('dom', '1.7.4')]:
        runtime = (source_dir / ('floating-ui-' + component + '-runtime.js')).read_text(encoding='utf-8')
        url = 'https://unpkg.com/@floating-ui/' + component + '@' + version + '/dist/floating-ui.' + component + '.umd.min.js'
        pattern = r'<script\b[^>]*\bsrc="' + re.escape(url) + r'"[^>]*>\s*</script>'
        inner, replaced = re.subn(pattern, lambda _: '<script>' + runtime.replace('</script', '<\\/script') + '</script>', inner)
        assert replaced == 1, component + ' runtime was not embedded'
    assets = re.findall(r'<script[^>]+src=[\"\x27](https?://[^\"\x27]+)', inner)
    assert not assets, assets
    wrapper = wrapper[:match.start(1)] + html.escape(inner, quote=True) + wrapper[match.end(1):]
    write_utf8(output / 'preview.html', wrapper)

    cache = []
    with zipfile.ZipFile(output / 'design-cache.zip', 'w', zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
        for file in sorted(source_dir.rglob('*')):
            if not file.is_file():
                continue
            relative = file.relative_to(source_dir).as_posix()
            data = file.read_bytes()
            archive.writestr(relative, data)
            cache.append({'path': relative, 'bytes': len(data), 'sha256': sha(data)})

    messages = []
    image_items = []
    local_files = []
    missing = []
    seen = {}
    summaries = []
    phases = collections.Counter()
    with zipfile.ZipFile(output / 'attachments.zip', 'w', zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
        def add_asset(data: bytes, suffix: str, original: str | None = None):
            digest = sha(data)
            if digest not in seen:
                prefix = 'images/' if (mimetypes.guess_type('asset' + suffix)[0] or '').startswith('image/') else 'files/'
                name = prefix + digest[:20] + suffix
                archive.writestr(name, data)
                seen[digest] = name
            return {'path': seen[digest], 'sha256': digest, 'bytes': len(data), **({'original': original} if original else {})}

        with args.session.open(encoding='utf-8') as stream:
            for line in stream:
                try:
                    record = json.loads(line)
                except json.JSONDecodeError:
                    continue
                payload = record.get('payload', {})
                # Export visible messages only. Never export reasoning, compaction internals,
                # system/developer instructions, credentials or native client databases.
                if record.get('type') != 'response_item' or payload.get('type') != 'message' or payload.get('role') not in ('user', 'assistant'):
                    continue
                phase = payload.get('phase')
                if phase not in (None, 'commentary', 'final_answer', 'final'):
                    continue
                texts, images, files = [], [], []
                for item in payload.get('content', []):
                    if item.get('type') in ('input_text', 'output_text'):
                        texts.append(item.get('text', ''))
                    elif item.get('type') == 'input_image':
                        uri = item.get('image_url', '')
                        m = re.match(r'data:(image/[^;,]+);base64,(.*)', uri, re.DOTALL)
                        if m:
                            suffix = mimetypes.guess_extension(m.group(1)) or '.img'
                            asset = add_asset(base64.b64decode(m.group(2)), suffix)
                            images.append(asset)
                            image_items.append({'message': len(messages) + 1, **asset})
                        else:
                            missing.append({'message': len(messages) + 1, 'kind': 'image', 'reason': 'Image was not embedded'})
                text = '\n\n'.join(texts)
                for path in re.findall(r'[A-Za-z]:[\\/][^\r\n<>"|]*?\.(?:png|jpg|jpeg|webp|gif|txt|pdf|docx)', text, re.IGNORECASE):
                    candidate = Path(path)
                    if candidate.is_file():
                        data = candidate.read_bytes()
                        asset = add_asset(data, candidate.suffix, path)
                        local_files.append({'message': len(messages) + 1, **asset})
                        files.append(asset)
                    else:
                        missing.append({'message': len(messages) + 1, 'kind': 'original-path', 'original': path, 'reason': 'Original local path unavailable; message image may still be preserved as an embedded attachment'})
                metadata = payload.get('internal_chat_message_metadata_passthrough', {})
                messages.append({'sequence': len(messages) + 1, 'timestamp': metadata.get('create_time', record.get('timestamp')), 'role': payload['role'], 'phase': phase, 'text': text, 'images': images, 'files': files})
                phases[payload['role']] += 1

        archive.writestr('manifest.json', json.dumps({'image_messages': image_items, 'original_files': local_files, 'missing_original_paths': missing}, ensure_ascii=False, indent=2))

    write_utf8(output / 'conversation.jsonl', ''.join(json.dumps(message, ensure_ascii=False) + '\n' for message in messages))
    readable = ['# 排一下可读会话记录\n', '截至导出时的用户和助手可见消息。模型私有推理、系统指令和客户端内部状态不在本文件中。图片位于 attachments.zip，解压至 attachments 后可按下方路径查看。\n']
    for message in messages:
        role = '用户' if message['role'] == 'user' else '助手'
        readable.append(f'\n## {message["sequence"]} {role}\n\n{message["text"]}\n')
        for asset in message['images']:
            readable.append(f'\n![会话图片](attachments/{asset["path"]})\n')
        for asset in message['files']:
            if asset['path'].startswith('files/'):
                readable.append(f'\n附件 [{Path(asset["original"]).name}](attachments/{asset["path"]})\n')
    write_utf8(output / 'conversation.md', '\n'.join(readable))

    # The exported conversation can contain visible state summaries. These are
    # intentionally not presented as a complete export of browser privateContent.
    with args.session.open(encoding='utf-8') as stream:
        for line in stream:
            try:
                record = json.loads(line)
            except json.JSONDecodeError:
                continue
            payload = record.get('payload', {})
            if record.get('type') != 'response_item' or payload.get('type') not in ('custom_tool_call_output', 'function_call_output'):
                continue
            value = payload.get('output')
            if isinstance(value, str) and 'requirement-modal-study.html' in value:
                try:
                    candidate = json.loads(value)
                except (ValueError, TypeError):
                    continue
                if isinstance(candidate, dict) and isinstance(candidate.get('state'), dict) and 'requirement-modal-study.html' in candidate.get('path', ''):
                    summaries.append(candidate)
    write_utf8(output / 'preview-state-summary.json', json.dumps({'complete_browser_state': False, 'last_visible_summary': summaries[-1] if summaries else None, 'note': 'Visible model state is not the complete private widget state; do not synthesize missing requirements, drafts, versions, logs or avatar bytes from this summary.'}, ensure_ascii=False, indent=2))

    skill_files = []
    skill_roots = {'frontend-design': args.skills_root / 'frontend-design', 'ui-ux-pro-max': args.skills_root / 'ui-ux-pro-max', 'visualize': args.visualize_skill}
    excluded = {'.git', '__pycache__', 'node_modules', '.venv', 'target'}
    with zipfile.ZipFile(output / 'design-tools.zip', 'w', zipfile.ZIP_DEFLATED, compresslevel=6, strict_timestamps=False) as archive:
        for name, root in skill_roots.items():
            if not root.is_dir():
                continue
            for file in sorted(root.rglob('*')):
                if not file.is_file() or any(part in excluded for part in file.relative_to(root).parts):
                    continue
                relative = name + '/' + file.relative_to(root).as_posix()
                archive.write(file, relative)
                skill_files.append({'path': relative, 'bytes': file.stat().st_size})

    for file in output.iterdir():
        if file.is_file() and file.suffix in ('.md', '.py', '.html', '.json', '.jsonl', '.txt'):
            write_utf8(file, file.read_text(encoding='utf-8'))
    manifest = {'created_at': created, 'repository': 'https://github.com/BigdataZjk/Gantt', 'folder': 'handoff', 'stage': 'UI complete; formal technical stack awaiting user decision', 'canonical_source': 'ui-source.html', 'source_sha256': sha((output/'ui-source.html').read_bytes()), 'original_source_sha256': sha(source.read_bytes()), 'source_directory_original': str(source_dir), 'session_original': str(args.session), 'visible_message_counts': dict(phases), 'messages': len(messages), 'embedded_images': len(image_items), 'unique_attachment_files': len(seen), 'missing_original_paths': missing, 'cache_files': cache, 'design_tool_files': skill_files, 'limits': {'all_task_visualization_files_archived': True, 'private_browser_widget_state_exported': False, 'raw_native_session_exported': False, 'server_prompt_cache_exported': False, 'credentials_or_private_reasoning_exported': False, 'native_cross_platform_resume_verified': False}, 'excluded': ['model private reasoning', 'system and developer instructions', 'account authentication tokens and SSH keys', 'other conversations', 'entire machine application caches', 'Windows application binaries'], 'artifacts': []}
    for file in sorted(output.iterdir()):
        if file.is_file() and file.name not in ('manifest.json', 'SHA256SUMS'):
            data = file.read_bytes()
            manifest['artifacts'].append({'path': file.name, 'bytes': len(data), 'sha256': sha(data)})
    write_utf8(output / 'manifest.json', json.dumps(manifest, ensure_ascii=False, indent=2))
    sums = []
    for file in sorted(output.iterdir()):
        if file.is_file() and file.name != 'SHA256SUMS':
            sums.append(sha(file.read_bytes()) + '  ' + file.name)
    write_utf8(output / 'SHA256SUMS', '\n'.join(sums) + '\n')
    print(json.dumps({'visible_messages': len(messages), 'embedded_images': len(image_items), 'unique_attachments': len(seen), 'missing_original_paths': len(missing), 'cache_files': len(cache), 'skill_files': len(skill_files), 'export_bytes': sum(file.stat().st_size for file in output.iterdir() if file.is_file())}, ensure_ascii=False))


if __name__ == '__main__':
    main()
