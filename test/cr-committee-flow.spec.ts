import { CrService } from '../src/change-requests/cr-service';
import { CrRepo } from '../src/change-requests/cr-repo';
import { CrAction, CrStatus } from '../src/change-requests/cr.enums';
import { Budget, ChangeRequest, COMMITTEE_DELTA_THRESHOLD } from '../src/change-requests/cr.types';
import { BusinessError } from '../src/common/errors';
import { buildSeed } from '../src/seed';

/**
 * Large-delta committee approval. Permissions are not part of this case.
 * Data: the line items from seed CR-PENDING-LARGE (delta 4000), started as a draft
 * so the service can submit it. Committee from seed: members carl and dina, head dina.
 *
 * 4000 > 1000, so both members must accept and the head must accept.
 * DRAFT → SUBMITTED → PENDING_APPROVAL → COMMITTEE_VOTING → COMMITTEE_DECISION → APPROVED.
 */
describe('CR committee flow when both members accept', () => {
	const at = {
		submit: '2026-03-04T09:00:00.000Z',
		send: '2026-03-04T10:00:00.000Z',
		carl: '2026-03-04T11:00:00.000Z',
		dina: '2026-03-04T12:00:00.000Z',
	};

	function freshService(): CrService {
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
		const repo = new CrRepo();
		repo.seed(structuredClone([...seed.changeRequests, draft]));
		return new CrService(repo, structuredClone(seed.agreements), structuredClone(seed.budgets), seed.committeeConfig);
	}

	it('routes a large draft to the committee and approves it when the head and the other member accept', () => {
		const service = freshService();
		const { alice, carl, dina } = buildSeed().users;

		const submitted = service.submit(alice, 'CR-LARGE-DRAFT', at.submit);
		expect(submitted.status).toBe(CrStatus.SUBMITTED);

		const voting = service.sendForApproval(alice, 'CR-LARGE-DRAFT', at.send);
		expect(voting.totals).toEqual({ baselineTotal: 8000, newTotal: 12000, delta: 4000 });
		expect(voting.totals.delta).toBeGreaterThan(COMMITTEE_DELTA_THRESHOLD);
		expect(voting.status).toBe(CrStatus.COMMITTEE_VOTING);
		expect(voting.committee).toMatchObject({ members: ['carl', 'dina'], head: 'dina', votes: [] });

		const afterCarl = service.castVote(carl, 'CR-LARGE-DRAFT', 'APPROVE', at.carl);
		expect(afterCarl.status).toBe(CrStatus.COMMITTEE_VOTING);
		expect(afterCarl.committee?.votes).toEqual([{ userId: 'carl', decision: 'APPROVE', at: at.carl }]);

		const approved = service.castVote(dina, 'CR-LARGE-DRAFT', 'APPROVE', at.dina);
		expect(approved.status).toBe(CrStatus.APPROVED);
		expect(approved.committee?.resolvedAt).toBe(at.dina);
		expect(approved.committee?.votes).toEqual([
			{ userId: 'carl', decision: 'APPROVE', at: at.carl },
			{ userId: 'dina', decision: 'APPROVE', at: at.dina },
		]);
		expect(approved.audit).toEqual([
			{ action: CrAction.SUBMIT, byUserId: 'alice', at: at.submit },
			{ action: CrAction.SEND_FOR_APPROVAL, byUserId: 'alice', at: at.send },
			{ action: CrAction.SEND_FOR_APPROVAL, byUserId: 'alice', at: at.send },
			{ action: CrAction.CAST_VOTE, byUserId: 'carl', at: at.carl },
			{ action: CrAction.CAST_VOTE, byUserId: 'dina', at: at.dina },
			{ action: CrAction.RESOLVE_COMMITTEE, byUserId: 'dina', at: at.dina },
			{ action: CrAction.RESOLVE_COMMITTEE, byUserId: 'dina', at: at.dina },
		]);
	});
});

/**
 * Same committee and the same large draft. These are the ways the vote ends without approving,
 * plus a member trying to vote twice.
 */
describe('CR committee flow when the vote does not approve', () => {
	const at = {
		submit: '2026-03-04T09:00:00.000Z',
		send: '2026-03-04T10:00:00.000Z',
		carl: '2026-03-04T11:00:00.000Z',
		dina: '2026-03-04T12:00:00.000Z',
		again: '2026-03-04T13:00:00.000Z',
	};

	function freshService(): { service: CrService; budgets: Map<string, Budget> } {
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
		const repo = new CrRepo();
		const budgets = structuredClone(seed.budgets);
		repo.seed(structuredClone([...seed.changeRequests, draft]));
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

	function openVoting(service: CrService): void {
		const { alice } = buildSeed().users;
		service.submit(alice, 'CR-LARGE-DRAFT', at.submit);
		const voting = service.sendForApproval(alice, 'CR-LARGE-DRAFT', at.send);
		expect(voting.status).toBe(CrStatus.COMMITTEE_VOTING);
		expect(voting.totals.delta).toBeGreaterThan(COMMITTEE_DELTA_THRESHOLD);
	}

	it('rejects when the head votes no', () => {
		const { service, budgets } = freshService();
		const { carl, dina } = buildSeed().users;
		openVoting(service);

		const afterCarl = service.castVote(carl, 'CR-LARGE-DRAFT', 'APPROVE', at.carl);
		expect(afterCarl.status).toBe(CrStatus.COMMITTEE_VOTING);

		const rejected = service.castVote(dina, 'CR-LARGE-DRAFT', 'REJECT', at.dina);
		expect(rejected.status).toBe(CrStatus.REJECTED);
		expect(rejected.committee?.resolvedAt).toBe(at.dina);
		expect(rejected.committee?.votes).toEqual([
			{ userId: 'carl', decision: 'APPROVE', at: at.carl },
			{ userId: 'dina', decision: 'REJECT', at: at.dina },
		]);
		expect(rejected.audit.map((entry) => entry.action)).toEqual([
			CrAction.SUBMIT,
			CrAction.SEND_FOR_APPROVAL,
			CrAction.SEND_FOR_APPROVAL,
			CrAction.CAST_VOTE,
			CrAction.CAST_VOTE,
			CrAction.RESOLVE_COMMITTEE,
			CrAction.RESOLVE_COMMITTEE,
		]);
		expect(budgets.get('BUD-1')).toMatchObject({ booked: 8000, balance: 10000 });
	});

	it('rejects when everyone has voted and there is no majority', () => {
		const { service, budgets } = freshService();
		const { carl, dina } = buildSeed().users;
		openVoting(service);

		const afterCarl = service.castVote(carl, 'CR-LARGE-DRAFT', 'REJECT', at.carl);
		expect(afterCarl.status).toBe(CrStatus.COMMITTEE_VOTING);

		const rejected = service.castVote(dina, 'CR-LARGE-DRAFT', 'APPROVE', at.dina);
		expect(rejected.status).toBe(CrStatus.REJECTED);
		expect(rejected.committee?.resolvedAt).toBe(at.dina);
		expect(rejected.committee?.votes).toEqual([
			{ userId: 'carl', decision: 'REJECT', at: at.carl },
			{ userId: 'dina', decision: 'APPROVE', at: at.dina },
		]);
		expect(budgets.get('BUD-1')).toMatchObject({ booked: 8000, balance: 10000 });
	});

	it('refuses a second vote from the same member and leaves the first vote in place', () => {
		const { service } = freshService();
		const { carl } = buildSeed().users;
		openVoting(service);

		service.castVote(carl, 'CR-LARGE-DRAFT', 'APPROVE', at.carl);
		expectBusinessError(() => service.castVote(carl, 'CR-LARGE-DRAFT', 'REJECT', at.again), 'VALIDATION');

		const cr = service.get(buildSeed().users.alice, 'CR-LARGE-DRAFT');
		expect(cr.status).toBe(CrStatus.COMMITTEE_VOTING);
		expect(cr.committee?.votes).toEqual([{ userId: 'carl', decision: 'APPROVE', at: at.carl }]);
		expect(cr.committee?.resolvedAt).toBeUndefined();
	});
});
