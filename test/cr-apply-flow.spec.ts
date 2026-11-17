import { CrService } from '../src/change-requests/cr-service';
import { CrRepo } from '../src/change-requests/cr-repo';
import { CrAction, CrStatus } from '../src/change-requests/cr.enums';
import { Budget, COMMITTEE_DELTA_THRESHOLD } from '../src/change-requests/cr.types';
import { buildSeed } from '../src/seed';

/**
 * Small-delta approval through to applied. Permissions are not part of this case.
 * Data: seed.ts, org-alpha, CR-DRAFT, agreement AGR-1, budget BUD-1.
 * Alice submits. Mona approves and applies.
 *
 * CR-DRAFT changes sku A from 10 to 11 at 500, so delta is 500.
 * 500 <= 1000, so the request stays with a single approver and the action is APPROVE.
 * DRAFT → SUBMITTED → PENDING_APPROVAL → APPROVED → APPLIED.
 */
describe('CR apply flow when delta is within the threshold', () => {
	const at = {
		submit: '2026-03-03T09:00:00.000Z',
		send: '2026-03-03T10:00:00.000Z',
		approve: '2026-03-03T11:00:00.000Z',
		apply: '2026-03-03T12:00:00.000Z',
	};

	function freshService(): { service: CrService; budgets: Map<string, Budget> } {
		const seed = buildSeed();
		const repo = new CrRepo();
		const budgets = structuredClone(seed.budgets);
		repo.seed(structuredClone(seed.changeRequests));
		return {
			service: new CrService(repo, structuredClone(seed.agreements), budgets, seed.committeeConfig),
			budgets,
		};
	}

	it('submits a draft, approves it under the threshold, and applies it', () => {
		const { service, budgets } = freshService();
		const { alice, mona } = buildSeed().users;
		expect(COMMITTEE_DELTA_THRESHOLD).toBe(1000);

		const submitted = service.submit(alice, 'CR-DRAFT', at.submit);
		expect(submitted.status).toBe(CrStatus.SUBMITTED);

		const pending = service.sendForApproval(alice, 'CR-DRAFT', at.send);
		expect(pending.status).toBe(CrStatus.PENDING_APPROVAL);
		expect(pending.totals).toEqual({ baselineTotal: 8000, newTotal: 8500, delta: 500 });
		expect(pending.totals.delta).toBeLessThanOrEqual(COMMITTEE_DELTA_THRESHOLD);
		expect(pending.committee).toBeUndefined();

		const approved = service.approve(mona, 'CR-DRAFT', at.approve);
		expect(approved.status).toBe(CrStatus.APPROVED);

		const applied = service.apply(mona, 'CR-DRAFT', at.apply);
		expect(applied.status).toBe(CrStatus.APPLIED);
		expect(applied.audit).toEqual([
			{ action: CrAction.SUBMIT, byUserId: 'alice', at: at.submit },
			{ action: CrAction.SEND_FOR_APPROVAL, byUserId: 'alice', at: at.send },
			{ action: CrAction.APPROVE, byUserId: 'mona', at: at.approve },
			{ action: CrAction.APPLY, byUserId: 'mona', at: at.apply },
		]);

		const budget = budgets.get('BUD-1');
		expect(budget?.booked).toBe(8500);
		expect(budget?.balance).toBe(9500);
	});

	it('approves a single-approver request and does not stop it for a committee vote or decision', () => {
		const seed = buildSeed();
		const requests = structuredClone(seed.changeRequests);
		const small = requests.find((cr) => cr.id === 'CR-PENDING-SMALL');
		if (!small) throw new Error('CR-PENDING-SMALL missing from seed');
		small.committee = { members: ['carl', 'dina'], head: 'dina', votes: [] };

		const repo = new CrRepo();
		repo.seed(requests);
		const service = new CrService(repo, structuredClone(seed.agreements), structuredClone(seed.budgets), seed.committeeConfig);
		const { mona } = seed.users;
		const pending = service.get(mona, 'CR-PENDING-SMALL');

		expect(pending.status).toBe(CrStatus.PENDING_APPROVAL);
		expect([CrStatus.COMMITTEE_VOTING, CrStatus.COMMITTEE_DECISION]).not.toContain(pending.status);
		expect(Math.abs(pending.totals.delta)).toBeLessThanOrEqual(COMMITTEE_DELTA_THRESHOLD);

		const approved = service.approve(mona, 'CR-PENDING-SMALL', at.approve);

		expect(approved.status).toBe(CrStatus.APPROVED);
		expect(approved.approvals).toEqual([{ userId: 'mona', action: CrAction.APPROVE, at: at.approve }]);
		expect(approved.audit).toEqual([{ action: CrAction.APPROVE, byUserId: 'mona', at: at.approve }]);
	});

	it('lets a single approver reject the request without a committee vote or decision', () => {
		const seed = buildSeed();
		const requests = structuredClone(seed.changeRequests);
		const small = requests.find((cr) => cr.id === 'CR-PENDING-SMALL');
		if (!small) throw new Error('CR-PENDING-SMALL missing from seed');
		small.committee = { members: ['carl', 'dina'], head: 'dina', votes: [] };

		const repo = new CrRepo();
		const budgets = structuredClone(seed.budgets);
		repo.seed(requests);
		const service = new CrService(repo, structuredClone(seed.agreements), budgets, seed.committeeConfig);
		const { mona } = seed.users;
		const pending = service.get(mona, 'CR-PENDING-SMALL');

		expect(pending.status).toBe(CrStatus.PENDING_APPROVAL);
		expect([CrStatus.COMMITTEE_VOTING, CrStatus.COMMITTEE_DECISION]).not.toContain(pending.status);
		expect(Math.abs(pending.totals.delta)).toBeLessThanOrEqual(COMMITTEE_DELTA_THRESHOLD);

		const rejected = service.reject(mona, 'CR-PENDING-SMALL', at.approve);

		expect(rejected.status).toBe(CrStatus.REJECTED);
		expect(rejected.audit).toEqual([{ action: CrAction.REJECT, byUserId: 'mona', at: at.approve }]);
		expect(budgets.get('BUD-1')).toMatchObject({ booked: 8000, balance: 10000 });
	});

	it('applies a negative delta and puts the money back on the budget', () => {
		const seed = buildSeed();
		const requests = structuredClone(seed.changeRequests);
		const draft = requests.find((cr) => cr.id === 'CR-DRAFT');
		if (!draft) throw new Error('CR-DRAFT missing from seed');
		draft.draftChanges = {
			lineItems: [
				{ sku: 'A', quantity: 9, unitPrice: 500 },
				{ sku: 'B', quantity: 30, unitPrice: 100 },
			],
		};
		const repo = new CrRepo();
		const budgets = structuredClone(seed.budgets);
		repo.seed(requests);
		const service = new CrService(repo, structuredClone(seed.agreements), budgets, seed.committeeConfig);
		const { alice, mona } = seed.users;

		service.submit(alice, 'CR-DRAFT', at.submit);
		const pending = service.sendForApproval(alice, 'CR-DRAFT', at.send);
		expect(pending.status).toBe(CrStatus.PENDING_APPROVAL);
		expect(pending.totals).toEqual({ baselineTotal: 8000, newTotal: 7500, delta: -500 });
		expect(Math.abs(pending.totals.delta)).toBeLessThanOrEqual(COMMITTEE_DELTA_THRESHOLD);

		expect(service.approve(mona, 'CR-DRAFT', at.approve).status).toBe(CrStatus.APPROVED);
		const applied = service.apply(mona, 'CR-DRAFT', at.apply);
		expect(applied.status).toBe(CrStatus.APPLIED);

		expect(budgets.get('BUD-1')).toMatchObject({ booked: 7500, balance: 10500 });
	});
});
