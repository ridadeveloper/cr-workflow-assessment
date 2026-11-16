import { CrService } from '../src/change-requests/cr-service';
import { CrRepo } from '../src/change-requests/cr-repo';
import { CrAction, CrStatus } from '../src/change-requests/cr.enums';
import { ChangeRequest, COMMITTEE_DELTA_THRESHOLD } from '../src/change-requests/cr.types';
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
