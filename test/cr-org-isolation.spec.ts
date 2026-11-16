import { CrService } from '../src/change-requests/cr-service';
import { CrRepo } from '../src/change-requests/cr-repo';
import { CrStatus } from '../src/change-requests/cr.enums';
import { Budget } from '../src/change-requests/cr.types';
import { BusinessError } from '../src/common/errors';
import { buildSeed } from '../src/seed';

/**
 * One organization acting on another organization's change request.
 * Mona is org-alpha and can approve and apply inside her org.
 * Bob is org-beta and can approve and apply inside his org.
 * CR-BETA belongs to org-beta. CR-PENDING-SMALL belongs to org-alpha.
 */
describe('CR organization isolation', () => {
	const at = '2026-03-09T09:00:00.000Z';

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

	it('refuses when one organization tries to change another organization change request', () => {
		const { service, budgets } = freshService();
		const { mona, bob } = buildSeed().users;

		expectBusinessError(() => service.get(mona, 'CR-BETA'), 'NOT_FOUND');
		expectBusinessError(() => service.approve(mona, 'CR-BETA', at), 'NOT_FOUND');
		expectBusinessError(() => service.apply(mona, 'CR-BETA', at), 'NOT_FOUND');
		expectBusinessError(() => service.cancel(mona, 'CR-BETA', at), 'NOT_FOUND');

		expectBusinessError(() => service.get(bob, 'CR-PENDING-SMALL'), 'NOT_FOUND');
		expectBusinessError(() => service.approve(bob, 'CR-PENDING-SMALL', at), 'NOT_FOUND');
		expectBusinessError(() => service.apply(bob, 'CR-PENDING-SMALL', at), 'NOT_FOUND');

		expect(service.get(bob, 'CR-BETA')).toMatchObject({
			id: 'CR-BETA',
			orgCode: 'org-beta',
			status: CrStatus.PENDING_APPROVAL,
			audit: [],
		});
		expect(service.get(mona, 'CR-PENDING-SMALL')).toMatchObject({
			id: 'CR-PENDING-SMALL',
			orgCode: 'org-alpha',
			status: CrStatus.PENDING_APPROVAL,
			audit: [],
		});
		expect(budgets.get('BUD-9')).toMatchObject({ booked: 1000, balance: 4000 });
		expect(budgets.get('BUD-1')).toMatchObject({ booked: 8000, balance: 10000 });
	});
});
