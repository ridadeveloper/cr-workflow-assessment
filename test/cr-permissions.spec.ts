import { CrService } from '../src/change-requests/cr-service';
import { CrRepo } from '../src/change-requests/cr-repo';
import { CrStatus } from '../src/change-requests/cr.enums';
import { ChangeRequest } from '../src/change-requests/cr.types';
import { BusinessError } from '../src/common/errors';
import { ReqUser } from '../src/common/policy';
import { buildSeed } from '../src/seed';

/**
 * Permission strings only. The change-request flow specs stay as they are.
 * Alice can update and read her own requests. Mona can update, approve, and apply in the org.
 * Carl can read and approve in the org. He is a committee member. He cannot apply.
 */
describe('CR permissions', () => {
	const at = '2026-03-08T09:00:00.000Z';

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

	it('lists by read scope and refuses a user who cannot read', () => {
		const seed = buildSeed();
		const draft = seed.changeRequests.find((cr) => cr.id === 'CR-DRAFT');
		if (!draft) throw new Error('CR-DRAFT missing from seed');
		const monaOwned: ChangeRequest = { ...structuredClone(draft), id: 'CR-MONA', createdBy: 'mona' };
		const service = freshService([monaOwned]);
		const { alice, carl, bob } = seed.users;
		const noRead: ReqUser = { id: 'nora', orgCode: 'org-alpha', workspaceIds: ['ws-1'], policies: [] };
		const otherWorkspace: ReqUser = { id: 'wes', orgCode: 'org-alpha', workspaceIds: ['ws-9'], policies: ['cr_r_w'] };

		expectBusinessError(() => service.list(noRead), 'FORBIDDEN');

		const aliceIds = service.list(alice).map((cr) => cr.id);
		expect(aliceIds).toContain('CR-DRAFT');
		expect(aliceIds).not.toContain('CR-MONA');
		expect(aliceIds).not.toContain('CR-BETA');

		const carlIds = service.list(carl).map((cr) => cr.id);
		expect(carlIds).toEqual(expect.arrayContaining(['CR-DRAFT', 'CR-MONA']));
		expect(carlIds).not.toContain('CR-BETA');

		expect(service.list(bob).map((cr) => cr.id)).toEqual(['CR-BETA']);
		expect(service.list(otherWorkspace)).toEqual([]);
	});

	it('requires an update permission to submit or send for approval', () => {
		const service = freshService();
		const { alice, carl } = buildSeed().users;

		expectBusinessError(() => service.submit(carl, 'CR-DRAFT', at), 'FORBIDDEN');
		expect(service.get(alice, 'CR-DRAFT').status).toBe(CrStatus.DRAFT);

		expect(service.submit(alice, 'CR-DRAFT', at).status).toBe(CrStatus.SUBMITTED);
		expectBusinessError(() => service.sendForApproval(carl, 'CR-DRAFT', at), 'FORBIDDEN');
		expect(service.get(alice, 'CR-DRAFT').status).toBe(CrStatus.SUBMITTED);

		expect(service.sendForApproval(alice, 'CR-DRAFT', at).status).toBe(CrStatus.PENDING_APPROVAL);
	});

	it('requires an approve permission to cancel, approve, reject, or return', () => {
		const { alice, mona } = buildSeed().users;
		const cancelService = freshService();

		expectBusinessError(() => cancelService.cancel(alice, 'CR-DRAFT', at), 'FORBIDDEN');
		expect(cancelService.get(alice, 'CR-DRAFT').status).toBe(CrStatus.DRAFT);
		expect(cancelService.cancel(mona, 'CR-DRAFT', at).status).toBe(CrStatus.CANCELLED);

		const pending = freshService();
		expectBusinessError(() => pending.approve(alice, 'CR-PENDING-SMALL', at), 'FORBIDDEN');
		expectBusinessError(() => pending.reject(alice, 'CR-PENDING-SMALL', at), 'FORBIDDEN');
		expectBusinessError(() => pending.returnToDraft(alice, 'CR-PENDING-SMALL', at), 'FORBIDDEN');
		expect(pending.get(alice, 'CR-PENDING-SMALL').status).toBe(CrStatus.PENDING_APPROVAL);
		expect(pending.approve(mona, 'CR-PENDING-SMALL', at).status).toBe(CrStatus.APPROVED);
	});

	it('requires an apply permission before it changes the budget', () => {
		const service = freshService();
		const { alice, carl, mona } = buildSeed().users;

		expect(service.approve(mona, 'CR-PENDING-SMALL', at).status).toBe(CrStatus.APPROVED);
		expectBusinessError(() => service.apply(alice, 'CR-PENDING-SMALL', at), 'FORBIDDEN');
		expectBusinessError(() => service.apply(carl, 'CR-PENDING-SMALL', at), 'FORBIDDEN');
		expect(service.get(mona, 'CR-PENDING-SMALL').status).toBe(CrStatus.APPROVED);
		expect(service.apply(mona, 'CR-PENDING-SMALL', at).status).toBe(CrStatus.APPLIED);
	});

	it('lets only committee members cast a vote', () => {
		const seed = buildSeed();
		const large = seed.changeRequests.find((cr) => cr.id === 'CR-PENDING-LARGE');
		if (!large) throw new Error('CR-PENDING-LARGE missing from seed');
		const draft: ChangeRequest = {
			...structuredClone(large),
			id: 'CR-LARGE-DRAFT',
			status: CrStatus.DRAFT,
			totals: { baselineTotal: 0, newTotal: 0, delta: 0 },
			approvals: [],
			audit: [],
		};
		const service = freshService([draft]);
		const { alice, carl } = seed.users;

		service.submit(alice, 'CR-LARGE-DRAFT', at);
		expect(service.sendForApproval(alice, 'CR-LARGE-DRAFT', at).status).toBe(CrStatus.COMMITTEE_VOTING);

		expectBusinessError(() => service.castVote(alice, 'CR-LARGE-DRAFT', 'APPROVE', at), 'FORBIDDEN');
		expect(service.get(alice, 'CR-LARGE-DRAFT').status).toBe(CrStatus.COMMITTEE_VOTING);
		expect(service.get(alice, 'CR-LARGE-DRAFT').committee?.votes).toEqual([]);

		const afterCarl = service.castVote(carl, 'CR-LARGE-DRAFT', 'APPROVE', at);
		expect(afterCarl.status).toBe(CrStatus.COMMITTEE_VOTING);
		expect(afterCarl.committee?.votes).toEqual([{ userId: 'carl', decision: 'APPROVE', at }]);
	});
});
