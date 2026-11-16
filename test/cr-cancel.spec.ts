import { CrService } from '../src/change-requests/cr-service';
import { CrRepo } from '../src/change-requests/cr-repo';
import { CrAction, CrStatus } from '../src/change-requests/cr.enums';
import { ChangeRequest } from '../src/change-requests/cr.types';
import { BusinessError } from '../src/common/errors';
import { buildSeed } from '../src/seed';

/**
 * Cancelling a draft.
 * Data: seed.ts, org-alpha, CR-DRAFT, user alice.
 *
 * DRAFT → CANCELLED is terminal. Later actions leave the status and the audit unchanged.
 * RETURNED, APPLIED, and COMMITTEE_DECISION cannot be cancelled.
 * A separate case checks update permission before cancel and approve permission before return.
 */
describe('CR cancel flow', () => {
	const at = {
		cancel: '2026-03-02T09:00:00.000Z',
		later: '2026-03-02T10:00:00.000Z',
	};

	function freshService(extra: ChangeRequest[] = []): CrService {
		const seed = buildSeed();
		const repo = new CrRepo();
		repo.seed(structuredClone([...seed.changeRequests, ...extra]));
		return new CrService(repo, structuredClone(seed.agreements), structuredClone(seed.budgets), seed.committeeConfig);
	}

	function expectBusinessError(run: () => void, code: BusinessError['code']): void {
		try {
			run();
		} catch (err) {
			expect(err).toBeInstanceOf(BusinessError);
			expect((err as BusinessError).code).toBe(code);
			return;
		}
		throw new Error(`expected a ${code} business error`);
	}

	it('cancels a draft and refuses every later transition', () => {
		const service = freshService();
		const { mona } = buildSeed().users;

		const cancelled = service.cancel(mona, 'CR-DRAFT', at.cancel);
		expect(cancelled.status).toBe(CrStatus.CANCELLED);
		expect(cancelled.audit).toEqual([{ action: CrAction.CANCEL, byUserId: 'mona', at: at.cancel }]);

		const attempts: Array<{ run: () => void; code: BusinessError['code'] }> = [
			{ run: () => service.submit(mona, 'CR-DRAFT', at.later), code: 'TERMINAL_STATE' },
			{ run: () => service.sendForApproval(mona, 'CR-DRAFT', at.later), code: 'TERMINAL_STATE' },
			{ run: () => service.approve(mona, 'CR-DRAFT', at.later), code: 'TERMINAL_STATE' },
			{ run: () => service.returnToDraft(mona, 'CR-DRAFT', at.later), code: 'VALIDATION' },
			{ run: () => service.reject(mona, 'CR-DRAFT', at.later), code: 'TERMINAL_STATE' },
			{ run: () => service.apply(mona, 'CR-DRAFT', at.later), code: 'VALIDATION' },
		];

		for (const attempt of attempts) {
			expectBusinessError(attempt.run, attempt.code);
		}

		const after = service.get(mona, 'CR-DRAFT');
		expect(after.status).toBe(CrStatus.CANCELLED);
		expect(after.audit).toEqual([{ action: CrAction.CANCEL, byUserId: 'mona', at: at.cancel }]);
	});

	it('checks approve permission before cancel, then leaves the cancelled request unchanged', () => {
		const service = freshService();
		const { alice, mona } = buildSeed().users;

		expectBusinessError(() => service.cancel(alice, 'CR-DRAFT', at.cancel), 'FORBIDDEN');
		expect(service.get(alice, 'CR-DRAFT').status).toBe(CrStatus.DRAFT);
		expect(service.get(alice, 'CR-DRAFT').audit).toEqual([]);

		const cancelled = service.cancel(mona, 'CR-DRAFT', at.cancel);
		expect(cancelled.status).toBe(CrStatus.CANCELLED);
		expectBusinessError(() => service.returnToDraft(mona, 'CR-DRAFT', at.later), 'VALIDATION');
		expect(service.get(mona, 'CR-DRAFT').status).toBe(CrStatus.CANCELLED);
		expect(service.get(mona, 'CR-DRAFT').audit).toEqual([{ action: CrAction.CANCEL, byUserId: 'mona', at: at.cancel }]);
	});

	it('does not cancel a returned, applied, or committee-decision change request', () => {
		const seed = buildSeed();
		const draft = seed.changeRequests.find((cr) => cr.id === 'CR-DRAFT');
		if (!draft) throw new Error('CR-DRAFT missing from seed');

		const returned: ChangeRequest = {
			...structuredClone(draft),
			id: 'CR-RETURNED',
			status: CrStatus.RETURNED,
			audit: [{ action: CrAction.RETURN, byUserId: 'alice', at: '2026-03-01T11:00:00.000Z' }],
		};
		const committeeDecision: ChangeRequest = {
			...structuredClone(draft),
			id: 'CR-COMMITTEE-DECISION',
			status: CrStatus.COMMITTEE_DECISION,
			committee: { members: ['carl', 'dina'], head: 'dina', votes: [] },
			audit: [{ action: CrAction.RESOLVE_COMMITTEE, byUserId: 'dina', at: '2026-03-01T12:00:00.000Z' }],
		};

		const service = freshService([returned, committeeDecision]);
		const { alice, mona } = seed.users;
		const blocked = [
			{ id: 'CR-RETURNED', status: CrStatus.RETURNED, code: 'ILLEGAL_TRANSITION' as const },
			{ id: 'CR-APPLIED', status: CrStatus.APPLIED, code: 'TERMINAL_STATE' as const },
			{ id: 'CR-COMMITTEE-DECISION', status: CrStatus.COMMITTEE_DECISION, code: 'ILLEGAL_TRANSITION' as const },
		];

		for (const item of blocked) {
			const before = service.get(alice, item.id);
			expect(before.status).toBe(item.status);
			const audit = [...before.audit];

			expectBusinessError(() => service.cancel(mona, item.id, at.cancel), item.code);

			const after = service.get(alice, item.id);
			expect(after.status).toBe(item.status);
			expect(after.audit).toEqual(audit);
		}
	});
});
