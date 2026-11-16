import { CrService } from '../src/change-requests/cr-service';
import { CrRepo } from '../src/change-requests/cr-repo';
import { CrStatus } from '../src/change-requests/cr.enums';
import { computeTotals } from '../src/change-requests/cr-totals';
import { BusinessError } from '../src/common/errors';
import { buildSeed } from '../src/seed';

/**
 * Every seed record. Permissions are not part of this case.
 * Actors are used only as the people stored on the records.
 */
describe('seed data', () => {
	const at = {
		submit: '2026-03-07T09:00:00.000Z',
		send: '2026-03-07T10:00:00.000Z',
		approve: '2026-03-07T11:00:00.000Z',
		apply: '2026-03-07T12:00:00.000Z',
	};

	function freshService(): { service: CrService; budgets: ReturnType<typeof buildSeed>['budgets'] } {
		const seed = buildSeed();
		const repo = new CrRepo();
		const budgets = structuredClone(seed.budgets);
		repo.seed(structuredClone(seed.changeRequests));
		return {
			service: new CrService(repo, structuredClone(seed.agreements), budgets, seed.committeeConfig),
			budgets,
		};
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

	it('loads every seeded user, agreement, budget, change request, and committee', () => {
		const seed = buildSeed();

		expect(seed.users.alice).toMatchObject({ id: 'alice', orgCode: 'org-alpha', workspaceIds: ['ws-1'] });
		expect(seed.users.mona).toMatchObject({ id: 'mona', orgCode: 'org-alpha', workspaceIds: ['ws-1'] });
		expect(seed.users.carl).toMatchObject({ id: 'carl', orgCode: 'org-alpha', workspaceIds: ['ws-1'] });
		expect(seed.users.dina).toMatchObject({ id: 'dina', orgCode: 'org-alpha', workspaceIds: ['ws-1'] });
		expect(seed.users.bob).toMatchObject({ id: 'bob', orgCode: 'org-beta', workspaceIds: ['ws-9'] });

		const agr1 = seed.agreements.get('AGR-1');
		const agr2 = seed.agreements.get('AGR-2');
		expect(agr1).toMatchObject({ orgCode: 'org-alpha', budgetId: 'BUD-1', currency: 'USD', total: 8000 });
		expect(agr2).toMatchObject({ orgCode: 'org-beta', budgetId: 'BUD-9', currency: 'USD', total: 1000 });
		expect(computeTotals(agr1!, { draftChanges: {} }).baselineTotal).toBe(8000);
		expect(computeTotals(agr2!, { draftChanges: {} }).baselineTotal).toBe(1000);

		expect(seed.budgets.get('BUD-1')).toMatchObject({ orgCode: 'org-alpha', allocated: 20000, booked: 8000, spent: 2000, balance: 10000 });
		expect(seed.budgets.get('BUD-LOW')).toMatchObject({ orgCode: 'org-alpha', allocated: 100, booked: 0, spent: 0, balance: 100 });
		expect(seed.budgets.get('BUD-9')).toMatchObject({ orgCode: 'org-beta', allocated: 5000, booked: 1000, spent: 0, balance: 4000 });
		expect([...seed.agreements.values()].map((agreement) => agreement.budgetId)).toEqual(['BUD-1', 'BUD-9']);

		expect(seed.changeRequests.map((cr) => [cr.id, cr.orgCode, cr.status, cr.agreementId])).toEqual([
			['CR-DRAFT', 'org-alpha', CrStatus.DRAFT, 'AGR-1'],
			['CR-PENDING-SMALL', 'org-alpha', CrStatus.PENDING_APPROVAL, 'AGR-1'],
			['CR-PENDING-LARGE', 'org-alpha', CrStatus.PENDING_APPROVAL, 'AGR-1'],
			['CR-APPLIED', 'org-alpha', CrStatus.APPLIED, 'AGR-1'],
			['CR-BETA', 'org-beta', CrStatus.PENDING_APPROVAL, 'AGR-2'],
		]);
		expect(seed.committeeConfig).toEqual({ members: ['carl', 'dina'], head: 'dina' });
	});

	it('keeps each organization on its own seeded change requests', () => {
		const { service } = freshService();
		const { alice, bob } = buildSeed().users;

		expect(service.list(alice).map((cr) => cr.id)).toEqual(['CR-DRAFT', 'CR-PENDING-SMALL', 'CR-PENDING-LARGE', 'CR-APPLIED']);
		expect(service.list(bob).map((cr) => cr.id)).toEqual(['CR-BETA']);
	});

	it('submits, approves, and applies CR-DRAFT against BUD-1', () => {
		const { service, budgets } = freshService();
		const { alice, mona } = buildSeed().users;

		expect(service.submit(alice, 'CR-DRAFT', at.submit).status).toBe(CrStatus.SUBMITTED);
		const pending = service.sendForApproval(alice, 'CR-DRAFT', at.send);
		expect(pending.status).toBe(CrStatus.PENDING_APPROVAL);
		expect(pending.totals).toEqual({ baselineTotal: 8000, newTotal: 8500, delta: 500 });

		expect(service.approve(mona, 'CR-DRAFT', at.approve).status).toBe(CrStatus.APPROVED);
		expect(service.apply(mona, 'CR-DRAFT', at.apply).status).toBe(CrStatus.APPLIED);
		expect(budgets.get('BUD-1')).toMatchObject({ booked: 8500, balance: 9500 });
	});

	it('approves and applies the seeded small pending request', () => {
		const { service, budgets } = freshService();
		const { alice, mona } = buildSeed().users;
		const totals = computeTotals(buildSeed().agreements.get('AGR-1')!, {
			draftChanges: service.get(alice, 'CR-PENDING-SMALL').draftChanges,
		});

		expect(service.get(alice, 'CR-PENDING-SMALL').status).toBe(CrStatus.PENDING_APPROVAL);
		expect(totals).toEqual({ baselineTotal: 8000, newTotal: 8500, delta: 500 });
		expect(service.approve(mona, 'CR-PENDING-SMALL', at.approve).status).toBe(CrStatus.APPROVED);
		expect(service.apply(mona, 'CR-PENDING-SMALL', at.apply).status).toBe(CrStatus.APPLIED);
		expect(budgets.get('BUD-1')).toMatchObject({ booked: 8500, balance: 9500 });
		expect(budgets.get('BUD-LOW')).toMatchObject({ balance: 100, booked: 0 });
	});

	it('approves and applies the seeded large pending request for 4000', () => {
		const { service, budgets } = freshService();
		const { alice, mona } = buildSeed().users;
		const pending = service.get(alice, 'CR-PENDING-LARGE');

		expect(pending.status).toBe(CrStatus.PENDING_APPROVAL);
		expect(pending.committee).toBeUndefined();
		expect(computeTotals(buildSeed().agreements.get('AGR-1')!, { draftChanges: pending.draftChanges })).toEqual({
			baselineTotal: 8000,
			newTotal: 12000,
			delta: 4000,
		});

		expect(service.approve(mona, 'CR-PENDING-LARGE', at.approve).status).toBe(CrStatus.APPROVED);
		expect(service.apply(mona, 'CR-PENDING-LARGE', at.apply).status).toBe(CrStatus.APPLIED);
		expect(budgets.get('BUD-1')).toMatchObject({ booked: 12000, balance: 6000 });
	});

	it('leaves the seeded applied request and BUD-1 unchanged', () => {
		const { service, budgets } = freshService();
		const { alice } = buildSeed().users;
		const applied = service.get(alice, 'CR-APPLIED');

		expect(applied.status).toBe(CrStatus.APPLIED);
		expect(applied.totals).toEqual({ baselineTotal: 8000, newTotal: 8500, delta: 500 });
		expect(applied.approvals).toEqual([{ userId: 'mona', action: 'APPROVE', at: '2026-01-01T00:00:00.000Z' }]);

		expectBusinessError(() => service.submit(alice, 'CR-APPLIED', at.submit), 'TERMINAL_STATE');
		expectBusinessError(() => service.approve(alice, 'CR-APPLIED', at.approve), 'TERMINAL_STATE');
		expectBusinessError(() => service.cancel(alice, 'CR-APPLIED', at.apply), 'TERMINAL_STATE');

		expect(service.get(alice, 'CR-APPLIED').status).toBe(CrStatus.APPLIED);
		expect(budgets.get('BUD-1')).toMatchObject({ booked: 8000, balance: 10000 });
	});

	it('approves and applies the seeded org-beta request against BUD-9', () => {
		const { service, budgets } = freshService();
		const { bob } = buildSeed().users;
		const pending = service.get(bob, 'CR-BETA');

		expect(pending.status).toBe(CrStatus.PENDING_APPROVAL);
		expect(pending.orgCode).toBe('org-beta');
		expect(computeTotals(buildSeed().agreements.get('AGR-2')!, { draftChanges: pending.draftChanges })).toEqual({
			baselineTotal: 1000,
			newTotal: 1200,
			delta: 200,
		});

		expect(service.approve(bob, 'CR-BETA', at.approve).status).toBe(CrStatus.APPROVED);
		expect(service.apply(bob, 'CR-BETA', at.apply).status).toBe(CrStatus.APPLIED);
		expect(budgets.get('BUD-9')).toMatchObject({ booked: 1200, balance: 3800 });
		expect(budgets.get('BUD-1')).toMatchObject({ booked: 8000, balance: 10000 });
	});
});
