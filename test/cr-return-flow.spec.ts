import { CrService } from '../src/change-requests/cr-service';
import { CrRepo } from '../src/change-requests/cr-repo';
import { CrAction, CrStatus } from '../src/change-requests/cr.enums';
import { assertTransition } from '../src/change-requests/cr-state-machine';
import { BusinessError } from '../src/common/errors';
import { buildSeed } from '../src/seed';

/**
 * Happy path: DRAFT → SUBMITTED → PENDING_APPROVAL → RETURNED → DRAFT.
 * Alice submits. Mona returns, because return and approve require cr_a_*.
 * A separate block checks that a user without cr_a_* is refused before the status changes.
 */
describe('CR return flow', () => {
	const at = {
		submit: '2026-03-01T09:00:00.000Z',
		send: '2026-03-01T10:00:00.000Z',
		returned: '2026-03-01T11:00:00.000Z',
		resubmit: '2026-03-01T12:00:00.000Z',
	};

	function freshService(): CrService {
		const seed = buildSeed();
		const repo = new CrRepo();
		repo.seed(structuredClone(seed.changeRequests));
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

	describe('happy path: draft, submitted, pending approval, returned, then draft', () => {
		it('walks CR-DRAFT through submission, pending approval, return, and back to draft', () => {
			const service = freshService();
			const { alice, mona } = buildSeed().users;

			const submitted = service.submit(alice, 'CR-DRAFT', at.submit);
			expect(submitted.status).toBe(CrStatus.SUBMITTED);
			expect(submitted.orgCode).toBe('org-alpha');

			const pending = service.sendForApproval(alice, 'CR-DRAFT', at.send);
			expect(pending.status).toBe(CrStatus.PENDING_APPROVAL);
			expect(pending.committee).toBeUndefined();

			const returned = service.returnToDraft(mona, 'CR-DRAFT', at.returned);
			expect(returned.status).toBe(CrStatus.DRAFT);
			expect(returned.approvals).toEqual([]);
			expect(returned.audit).toEqual([
				{ action: CrAction.SUBMIT, byUserId: 'alice', at: at.submit },
				{ action: CrAction.SEND_FOR_APPROVAL, byUserId: 'alice', at: at.send },
				{ action: CrAction.RETURN, byUserId: 'mona', at: at.returned },
				{ action: CrAction.RETURN, byUserId: 'mona', at: at.returned },
			]);

			const resubmitted = service.submit(alice, 'CR-DRAFT', at.resubmit);
			expect(resubmitted.status).toBe(CrStatus.SUBMITTED);
		});
	});

	describe('false flows around return', () => {
		it('rejects sending a draft straight to pending approval', () => {
			const service = freshService();
			const { alice } = buildSeed().users;

			expectBusinessError(() => service.sendForApproval(alice, 'CR-DRAFT', at.send), 'ILLEGAL_TRANSITION');
			expect(service.get(alice, 'CR-DRAFT').status).toBe(CrStatus.DRAFT);
		});

		it('rejects returning a change request that is still draft', () => {
			const service = freshService();
			const { alice, mona } = buildSeed().users;

			expectBusinessError(() => service.returnToDraft(mona, 'CR-DRAFT', at.returned), 'VALIDATION');
			expect(service.get(alice, 'CR-DRAFT').status).toBe(CrStatus.DRAFT);
		});

		it('rejects returning a change request that has only been submitted', () => {
			const service = freshService();
			const { alice, mona } = buildSeed().users;

			service.submit(alice, 'CR-DRAFT', at.submit);

			expectBusinessError(() => service.returnToDraft(mona, 'CR-DRAFT', at.returned), 'VALIDATION');
			expect(service.get(alice, 'CR-DRAFT').status).toBe(CrStatus.SUBMITTED);
		});

		it('rejects a direct jump from pending approval back to draft', () => {
			expect(() => assertTransition(CrStatus.PENDING_APPROVAL, CrStatus.DRAFT)).toThrow(BusinessError);
			expectBusinessError(() => assertTransition(CrStatus.PENDING_APPROVAL, CrStatus.DRAFT), 'ILLEGAL_TRANSITION');
		});

		it('does not move an approved or applied change request backward when it is returned', () => {
			const service = freshService();
			const { alice, mona } = buildSeed().users;

			const approved = service.approve(mona, 'CR-PENDING-SMALL', '2026-03-01T10:30:00.000Z');
			expect(approved.status).toBe(CrStatus.APPROVED);
			const approvedAudit = [...approved.audit];
			const approvedApprovals = [...approved.approvals];

			expectBusinessError(() => service.returnToDraft(mona, 'CR-PENDING-SMALL', at.returned), 'VALIDATION');
			const approvedAfter = service.get(alice, 'CR-PENDING-SMALL');
			expect(approvedAfter.status).toBe(CrStatus.APPROVED);
			expect(approvedAfter.audit).toEqual(approvedAudit);
			expect(approvedAfter.approvals).toEqual(approvedApprovals);

			const applied = service.get(alice, 'CR-APPLIED');
			expect(applied.status).toBe(CrStatus.APPLIED);
			const appliedAudit = [...applied.audit];
			const appliedApprovals = [...applied.approvals];

			expectBusinessError(() => service.returnToDraft(mona, 'CR-APPLIED', at.returned), 'VALIDATION');
			const appliedAfter = service.get(alice, 'CR-APPLIED');
			expect(appliedAfter.status).toBe(CrStatus.APPLIED);
			expect(appliedAfter.audit).toEqual(appliedAudit);
			expect(appliedAfter.approvals).toEqual(appliedApprovals);
		});

		it('rejects a second return once the request is already back in draft', () => {
			const service = freshService();
			const { alice, mona } = buildSeed().users;

			service.submit(alice, 'CR-DRAFT', at.submit);
			service.sendForApproval(alice, 'CR-DRAFT', at.send);
			const draft = service.returnToDraft(mona, 'CR-DRAFT', at.returned);
			expect(draft.status).toBe(CrStatus.DRAFT);

			expectBusinessError(() => service.returnToDraft(mona, 'CR-DRAFT', '2026-03-01T13:00:00.000Z'), 'VALIDATION');
			expect(service.get(alice, 'CR-DRAFT').status).toBe(CrStatus.DRAFT);
		});
	});

	describe('permissions', () => {
		it('refuses return and approve when the user has no approve permission', () => {
			const service = freshService();
			const { alice, mona } = buildSeed().users;

			service.submit(alice, 'CR-DRAFT', at.submit);
			service.sendForApproval(alice, 'CR-DRAFT', at.send);

			expectBusinessError(() => service.returnToDraft(alice, 'CR-DRAFT', at.returned), 'FORBIDDEN');
			expect(service.get(alice, 'CR-DRAFT').status).toBe(CrStatus.PENDING_APPROVAL);

			expectBusinessError(() => service.approve(alice, 'CR-PENDING-SMALL', at.returned), 'FORBIDDEN');
			expect(service.get(alice, 'CR-PENDING-SMALL').status).toBe(CrStatus.PENDING_APPROVAL);

			const returned = service.returnToDraft(mona, 'CR-DRAFT', at.returned);
			expect(returned.status).toBe(CrStatus.DRAFT);
		});
	});
});
