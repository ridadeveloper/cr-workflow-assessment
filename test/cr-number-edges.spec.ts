import { CrService } from '../src/change-requests/cr-service';
import { CrRepo } from '../src/change-requests/cr-repo';
import { CrStatus } from '../src/change-requests/cr.enums';
import { Budget, ChangeRequest, COMMITTEE_DELTA_THRESHOLD, PurchaseAgreement } from '../src/change-requests/cr.types';
import { BusinessError } from '../src/common/errors';
import { buildSeed } from '../src/seed';

/**
 * The digits in the flow are the threshold 1000, a committee of 2, and the budget balance.
 * An exception must leave those numbers and the change-request status as they were.
 */
describe('change request number edges', () => {
	const at = {
		submit: '2026-03-06T09:00:00.000Z',
		send: '2026-03-06T10:00:00.000Z',
		approve: '2026-03-06T11:00:00.000Z',
		apply: '2026-03-06T12:00:00.000Z',
	};

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

	function edgeRequest(unitPrice: number): ChangeRequest {
		return {
			id: 'CR-EDGE',
			orgCode: 'org-alpha',
			agreementId: 'AGR-EDGE',
			createdBy: 'alice',
			workspaceId: 'ws-1',
			type: ['ITEMS'],
			status: CrStatus.DRAFT,
			draftChanges: { lineItems: [{ sku: 'A', quantity: 1, unitPrice }] },
			totals: { baselineTotal: 0, newTotal: 0, delta: 0 },
			approvals: [],
			version: 1,
			audit: [],
		};
	}

	function edgeAgreement(budgetId: string): PurchaseAgreement {
		return {
			id: 'AGR-EDGE',
			orgCode: 'org-alpha',
			vendorOrgCode: 'vendor-x',
			currency: 'USD',
			status: 'ACTIVE',
			budgetId,
			endDate: '2026-12-31',
			lineItems: [{ sku: 'A', quantity: 1, unitPrice: 0 }],
			total: 0,
		};
	}

	function serviceFor(
		unitPrice: number,
		budget: Budget,
		committeeConfig?: { members: string[]; head: string },
	): { service: CrService; budget: Budget } {
		const seed = buildSeed();
		const repo = new CrRepo();
		repo.seed([edgeRequest(unitPrice)]);
		const budgets = new Map<string, Budget>([[budget.id, budget]]);
		const agreements = new Map<string, PurchaseAgreement>([[edgeAgreement(budget.id).id, edgeAgreement(budget.id)]]);
		return {
			service: new CrService(repo, agreements, budgets, committeeConfig ?? seed.committeeConfig),
			budget,
		};
	}

	it('does not change the form numbers when sending a draft throws', () => {
		const seed = buildSeed();
		const repo = new CrRepo();
		repo.seed(structuredClone(seed.changeRequests));
		const service = new CrService(repo, structuredClone(seed.agreements), structuredClone(seed.budgets), seed.committeeConfig);
		const { alice } = seed.users;

		expectBusinessError(() => service.sendForApproval(alice, 'CR-DRAFT', at.send), 'ILLEGAL_TRANSITION');

		const draft = service.get(alice, 'CR-DRAFT');
		expect(draft.status).toBe(CrStatus.DRAFT);
		expect(draft.totals).toEqual({ baselineTotal: 0, newTotal: 0, delta: 0 });
		expect(draft.audit).toEqual([]);
	});

	it('keeps a delta of exactly 1000 with a single approver', () => {
		const budget: Budget = { id: 'BUD-EDGE', orgCode: 'org-alpha', currency: 'USD', allocated: 5000, booked: 0, spent: 0, balance: 5000 };
		const { service } = serviceFor(COMMITTEE_DELTA_THRESHOLD, budget);
		const { alice } = buildSeed().users;

		service.submit(alice, 'CR-EDGE', at.submit);
		const pending = service.sendForApproval(alice, 'CR-EDGE', at.send);

		expect(pending.totals.delta).toBe(1000);
		expect(pending.status).toBe(CrStatus.PENDING_APPROVAL);
		expect(pending.committee).toBeUndefined();
	});

	it('opens a committee when the delta is one cent over 1000', () => {
		const budget: Budget = { id: 'BUD-EDGE', orgCode: 'org-alpha', currency: 'USD', allocated: 5000, booked: 0, spent: 0, balance: 5000 };
		const { service } = serviceFor(1000.01, budget);
		const { alice } = buildSeed().users;

		service.submit(alice, 'CR-EDGE', at.submit);
		const voting = service.sendForApproval(alice, 'CR-EDGE', at.send);

		expect(voting.totals.delta).toBe(1000.01);
		expect(voting.status).toBe(CrStatus.COMMITTEE_VOTING);
	});

	it('throws when the budget is short and leaves the balance unchanged', () => {
		const budget: Budget = { id: 'BUD-EDGE', orgCode: 'org-alpha', currency: 'USD', allocated: 1000, booked: 0, spent: 0, balance: 999.99 };
		const { service } = serviceFor(1000, budget);
		const { alice, mona } = buildSeed().users;

		service.submit(alice, 'CR-EDGE', at.submit);
		service.sendForApproval(alice, 'CR-EDGE', at.send);
		service.approve(mona, 'CR-EDGE', at.approve);

		expectBusinessError(() => service.apply(mona, 'CR-EDGE', at.apply), 'INSUFFICIENT_BUDGET');

		const cr = service.get(alice, 'CR-EDGE');
		expect(cr.status).toBe(CrStatus.APPROVED);
		expect(cr.totals.delta).toBe(1000);
		expect(budget.balance).toBe(999.99);
		expect(budget.booked).toBe(0);
	});

	it('applies when the balance is exactly the delta and ends at zero', () => {
		const budget: Budget = { id: 'BUD-EDGE', orgCode: 'org-alpha', currency: 'USD', allocated: 1000, booked: 0, spent: 0, balance: 1000 };
		const { service } = serviceFor(1000, budget);
		const { alice, mona } = buildSeed().users;

		service.submit(alice, 'CR-EDGE', at.submit);
		service.sendForApproval(alice, 'CR-EDGE', at.send);
		service.approve(mona, 'CR-EDGE', at.approve);
		const applied = service.apply(mona, 'CR-EDGE', at.apply);

		expect(applied.status).toBe(CrStatus.APPLIED);
		expect(budget.balance).toBe(0);
		expect(budget.booked).toBe(1000);
	});

	it('throws before routing when a large delta has a committee of zero members', () => {
		const budget: Budget = { id: 'BUD-EDGE', orgCode: 'org-alpha', currency: 'USD', allocated: 5000, booked: 0, spent: 0, balance: 5000 };
		const { service } = serviceFor(1000.01, budget, { members: [], head: '' });
		const { alice } = buildSeed().users;

		service.submit(alice, 'CR-EDGE', at.submit);
		expectBusinessError(() => service.sendForApproval(alice, 'CR-EDGE', at.send), 'VALIDATION');

		const cr = service.get(alice, 'CR-EDGE');
		expect(cr.status).toBe(CrStatus.SUBMITTED);
		expect(cr.totals).toEqual({ baselineTotal: 0, newTotal: 0, delta: 0 });
	});
});
