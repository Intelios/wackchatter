/** Preset Co-Creator session, draft revision, and guarded publication routes. */

import { createDefaultPreset } from '../../shared/prompt/defaults.ts';
import type {
  CreatePresetCocreatorSession,
  PatchPresetDraftRequest,
  PublishPresetDraftRequest,
  RenamePresetCocreatorSessionRequest,
  ReplacePresetDraftRequest,
  RestorePresetDraftRequest,
  SavePresetCocreatorDocument,
} from '../../shared/types/preset-cocreator.ts';
import { errorResponse, json, notFound, readJson } from '../lib/http.ts';
import { sanitizeFilename } from '../lib/paths.ts';
import { presetCocreatorStore } from '../lib/preset-cocreator.ts';
import {
  getPresetRecord,
  PresetConflictError,
  presetContentVersion,
  savePresetConditional,
} from '../lib/presets.ts';

function mutationResponse(
  id: string,
  result:
    | { kind: 'saved'; revision?: unknown; value?: unknown }
    | { kind: 'stale'; currentRevision: number }
    | { kind: 'notFound' },
): Response {
  if (result.kind === 'notFound') return notFound('Preset Co-Creator session not found.');
  if (result.kind === 'stale') {
    return json(
      {
        error: 'The session changed elsewhere.',
        code: 'stale_revision',
        currentRevision: result.currentRevision,
      },
      { status: 409 },
    );
  }
  const session = presetCocreatorStore().getSession(id);
  return session ? json(session) : notFound('Preset Co-Creator session not found.');
}

function conflictResponse(error: PresetConflictError): Response {
  return json(
    {
      error: error.message,
      code: error.code,
      currentVersion: error.currentVersion,
    },
    { status: 409 },
  );
}

function hasOnlyKeys(value: object, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

export async function handlePresetCocreatorRoute(
  request: Request,
  segments: string[],
): Promise<Response | null> {
  const store = presetCocreatorStore();
  const method = request.method;

  if (segments[0] !== 'sessions') return null;

  if (segments.length === 1) {
    if (method === 'GET') return json(store.listSessions());
    if (method === 'POST') {
      const body = await readJson<CreatePresetCocreatorSession>(request);
      if (!body) return errorResponse('A session request is required.');
      const record = body.presetId ? getPresetRecord(body.presetId) : null;
      if (body.presetId && !record) return notFound('Source preset not found.');
      try {
        return json(
          store.createSession({
            presetId: body.presetId ?? null,
            presetVersion: record?.version ?? null,
            preset: record?.preset ?? createDefaultPreset(),
            title: body.title,
            settings: body.settings,
          }),
          { status: 201 },
        );
      } catch (error) {
        return errorResponse((error as Error).message);
      }
    }
    return null;
  }

  const id = decodeURIComponent(segments[1]!);

  if (segments.length === 2) {
    if (method === 'GET') {
      const session = store.getSession(id);
      return session ? json(session) : notFound('Preset Co-Creator session not found.');
    }
    if (method === 'DELETE') {
      return store.deleteSession(id)
        ? json({ ok: true })
        : notFound('Preset Co-Creator session not found.');
    }
    if (method === 'PATCH') {
      const body = await readJson<RenamePresetCocreatorSessionRequest>(request);
      if (!body?.title?.trim()) return errorResponse('A session name is required.');
      try {
        const session = store.renameSession(id, body.title);
        return session ? json(session) : notFound('Preset Co-Creator session not found.');
      } catch (error) {
        return errorResponse((error as Error).message);
      }
    }
    return null;
  }

  if (segments[2] === 'document' && segments.length === 3 && method === 'PUT') {
    const body = await readJson<SavePresetCocreatorDocument>(request);
    if (
      !body ||
      !hasOnlyKeys(body, ['expectedRevision', 'operationId', 'document']) ||
      !Number.isSafeInteger(body.expectedRevision) ||
      !body.operationId ||
      !body.document
    ) {
      return errorResponse('A valid expected revision, operation id, and document are required.');
    }
    return mutationResponse(id, store.saveDocument(id, body));
  }

  if (segments[2] === 'draft' && segments.length === 4 && method === 'POST') {
    try {
      if (segments[3] === 'patch') {
        const body = await readJson<PatchPresetDraftRequest>(request);
        if (
          !body ||
          !hasOnlyKeys(body, [
            'expectedRevision',
            'operationId',
            'source',
            'summary',
            'turnId',
            'operations',
          ]) ||
          !Number.isSafeInteger(body.expectedRevision) ||
          !['assistant', 'manual'].includes(body.source) ||
          !Array.isArray(body.operations) ||
          !body.operationId ||
          typeof body.summary !== 'string'
        ) {
          return errorResponse('A patch and operation id are required.');
        }
        return mutationResponse(id, store.patchDraft(id, body));
      }
      if (segments[3] === 'replace') {
        const body = await readJson<ReplacePresetDraftRequest>(request);
        if (
          !body?.preset ||
          !hasOnlyKeys(body, ['expectedRevision', 'operationId', 'summary', 'preset']) ||
          !Number.isSafeInteger(body.expectedRevision) ||
          !body.operationId ||
          typeof body.summary !== 'string'
        ) {
          return errorResponse('A preset and operation id are required.');
        }
        return mutationResponse(id, store.replaceDraft(id, body));
      }
      if (segments[3] === 'restore') {
        const body = await readJson<RestorePresetDraftRequest>(request);
        if (
          !body ||
          !hasOnlyKeys(body, ['expectedRevision', 'operationId', 'revision', 'summary']) ||
          !Number.isSafeInteger(body.expectedRevision) ||
          !Number.isSafeInteger(body.revision) ||
          !body.operationId
        ) {
          return errorResponse('A revision and operation id are required.');
        }
        return mutationResponse(id, store.restoreDraft(id, body));
      }
    } catch (error) {
      return errorResponse((error as Error).message);
    }
  }

  if (segments[2] === 'publish' && segments.length === 3 && method === 'POST') {
    const body = await readJson<PublishPresetDraftRequest>(request);
    if (
      !body ||
      !hasOnlyKeys(body, ['revision', 'operationId', 'mode', 'name', 'expectedPresetVersion']) ||
      !['update', 'new', 'overwrite'].includes(body.mode) ||
      !body.operationId ||
      !Number.isSafeInteger(body.revision)
    ) {
      return errorResponse('A committed draft revision and operation id are required.');
    }
    const repeated = store.getPublication(id, body.operationId);
    if (repeated) return json(repeated);

    const session = store.getSession(id);
    if (!session) return notFound('Preset Co-Creator session not found.');
    const revision = session.history.find((entry) => entry.revision === body.revision);
    if (!revision) return errorResponse(`Preset revision ${body.revision} does not exist.`);

    let presetId: string;
    let expectedVersion: string | null;
    let created: boolean;
    if (body.mode === 'new') {
      const clean = body.name ? sanitizeFilename(body.name.replace(/\.json$/i, '')) : null;
      if (!clean) return errorResponse('A usable preset name is required.');
      presetId = clean;
      expectedVersion = null;
      created = true;
    } else {
      if (!session.targetPresetId) {
        return errorResponse('The source preset no longer exists. Save the draft as a new preset.');
      }
      presetId = session.targetPresetId;
      expectedVersion =
        body.expectedPresetVersion !== undefined
          ? body.expectedPresetVersion
          : session.targetPresetVersion;
      created = false;
    }

    // A new name that already existed before this operation is a real conflict even when
    // its bytes happen to match. Only a persisted attempt from an earlier interrupted call
    // may adopt a matching file as its own completed write.
    const currentBeforeAttempt = created ? getPresetRecord(presetId) : null;
    const attempt = store.beginPublication(id, body.operationId, revision.revision, presetId);
    if (!attempt) return notFound('Preset Co-Creator session not found.');
    if (currentBeforeAttempt && !attempt.repeated) {
      store.cancelPublication(id, body.operationId);
      return conflictResponse(new PresetConflictError(currentBeforeAttempt.version));
    }

    const desiredVersion = presetContentVersion(revision.preset);
    let savedVersion: string;
    try {
      savedVersion = (await savePresetConditional(presetId, revision.preset, expectedVersion))
        .version;
    } catch (error) {
      if (error instanceof PresetConflictError) {
        // The process may have stopped after replacing the file but before recording the
        // publication. Matching content proves this idempotent retry already landed.
        if (error.currentVersion !== desiredVersion || (created && !attempt.repeated)) {
          store.cancelPublication(id, body.operationId);
          return conflictResponse(error);
        }
        savedVersion = desiredVersion;
      } else {
        store.cancelPublication(id, body.operationId);
        throw error;
      }
    }

    const result = store.recordPublication(id, {
      operationId: body.operationId,
      presetId,
      version: savedVersion,
      revision: revision.revision,
      created,
    });
    return result ? json(result) : notFound('Preset Co-Creator session not found.');
  }

  return null;
}
