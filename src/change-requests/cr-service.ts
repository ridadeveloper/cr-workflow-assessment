import { CrRepo } from './cr-repo';
import { ChangeRequest, Budget, PurchaseAgreement, COMMITTEE_DELTA_THRESHOLD } from './cr.types';
import { CrStatus, CrAction } from './cr.enums';
import { assertTransition } from './cr-state-machine';
import { computeTotals } from './cr-totals';
import { Errors } from '../common/errors';
import { ReqUser, hasPolicy, crReadScope } from '../common/policy';
import { round2 } from '../common/money.util';

/**
 * Orchestrates CR actions. The transition + audit helper is provided; the action methods are
 * STUBS for you to implement (see `../../CANDIDATE_BRIEF.md`). Make the workflow correct, safe,
 * and complete.
 */
export class CrService {
	constructor(
		private readonly repo: CrRepo,
		private readonly agreements: Map<string, PurchaseAgreement>,
		private readonly budgets: Map<string, Budget>,
		// Committee membership used when routing large changes to a vote (Task 3).
		private readonly committeeConfig?: { members: string[]; head: string },
	) {}

	/** Load a CR for this user or throw NOT_FOUND. */
	private getOrThrow(user: ReqUser, id: string): ChangeRequest {
		const cr = this.repo.findOne(user, id);
		if (!cr) throw Errors.notFound(`CR ${id} not found`);
		return cr;
	}

	/** Apply a legal transition and append an immutable audit entry. Provided helper. */
	private transition(cr: ChangeRequest, to: CrStatus, action: CrAction, byUserId: string, at: string, note?: string): void {
		assertTransition(cr.status, to);
		cr.status = to;
		cr.audit = [...cr.audit, { action, byUserId, at, note }];
	}

	// ---- Actions to implement -------------------------------------------------------------

	submit(user: ReqUser, id: string, at: string): ChangeRequest {
		const cr = this.getOrThrow(user, id);
		if (!hasPolicy(user, 'cr_u_u') && !hasPolicy(user, 'cr_u_o') && !hasPolicy(user, 'cr_u_w')) throw Errors.forbidden('Cannot submit');
		this.transition(cr, CrStatus.SUBMITTED, CrAction.SUBMIT, user.id, at);
		return this.repo.save(cr);
	}

	cancel(user: ReqUser, id: string, at: string): ChangeRequest {
		if (!hasPolicy(user, 'cr_a_u') && !hasPolicy(user, 'cr_a_o') && !hasPolicy(user, 'cr_a_w')) throw Errors.forbidden('Cannot cancel');
		const cr = this.getOrThrow(user, id);
		this.transition(cr, CrStatus.CANCELLED, CrAction.CANCEL, user.id, at);
		return this.repo.save(cr);
	}

	sendForApproval(user: ReqUser, id: string, at: string): ChangeRequest {
		// TODO: move SUBMITTED -> PENDING_APPROVAL, and decide single-approver vs committee
		//       routing based on |delta| and COMMITTEE_DELTA_THRESHOLD.
		if (!hasPolicy(user, 'cr_u_u') && !hasPolicy(user, 'cr_u_o') && !hasPolicy(user, 'cr_u_w'))
			throw Errors.forbidden('Cannot send for approval');
		const cr = this.getOrThrow(user, id);
		const agreement = this.agreements.get(cr.agreementId);
		if (!agreement) throw Errors.notFound('Agreement not found');
		const totals = computeTotals(agreement, cr);
		const needCommittee = Math.abs(totals.delta) > COMMITTEE_DELTA_THRESHOLD;
		const members = this.committeeConfig?.members ?? [];
		const head = this.committeeConfig?.head ?? '';
		if (needCommittee && (members.length === 0 || !head)) {
			throw Errors.validation('Committee is not configured');
		}
		this.transition(cr, CrStatus.PENDING_APPROVAL, CrAction.SEND_FOR_APPROVAL, user.id, at);
		cr.totals = totals;
		if (needCommittee) {
			cr.committee = { members, head, votes: [] };
			this.transition(cr, CrStatus.COMMITTEE_VOTING, CrAction.SEND_FOR_APPROVAL, user.id, at);
		}
		return this.repo.save(cr);
	}

	approve(user: ReqUser, id: string, at: string): ChangeRequest {
		// TODO: permission check (cr_a_*); legal transition; record approval + audit.
		//       Committee CRs approve only via committee resolution.
		if (!hasPolicy(user, 'cr_a_u') && !hasPolicy(user, 'cr_a_o') && !hasPolicy(user, 'cr_a_w')) throw Errors.forbidden('Cannot approve');
		const cr = this.getOrThrow(user, id);
		const singleApproval =
			cr.status === CrStatus.PENDING_APPROVAL && Math.abs(cr.totals.delta) <= COMMITTEE_DELTA_THRESHOLD;
		if (!singleApproval) {
			if (cr.status === CrStatus.COMMITTEE_VOTING || cr.status === CrStatus.COMMITTEE_DECISION) {
				throw Errors.validation('Committee CRs approve only via committee resolution');
			}
			if (Math.abs(cr.totals.delta) > COMMITTEE_DELTA_THRESHOLD) {
				throw Errors.validation('Large changes must be resolved by the committee');
			}
		}
		this.transition(cr, CrStatus.APPROVED, CrAction.APPROVE, user.id, at);
		cr.approvals = [...cr.approvals, { userId: user.id, action: CrAction.APPROVE, at }];
		return this.repo.save(cr);
	}

	castVote(user: ReqUser, id: string, decision: 'APPROVE' | 'REJECT', at: string): ChangeRequest {
		// TODO: only committee members may vote; resolve on majority + head decision.
		const cr = this.getOrThrow(user, id);
		const committee = cr.committee;
		if (cr.status !== CrStatus.COMMITTEE_VOTING || !committee) {
			throw Errors.validation('Change request is not in committee voting');
		}
		if (!committee.members.includes(user.id)) {
			throw Errors.forbidden('Only committee members may vote');
		}
		if (committee.votes.some((vote) => vote.userId === user.id)) {
			throw Errors.validation('Member has already voted');
		}
		committee.votes.push({ userId: user.id, decision, at });
		cr.audit = [...cr.audit, { action: CrAction.CAST_VOTE, byUserId: user.id, at }];
		const approveCount = committee.votes.filter((vote) => vote.decision === 'APPROVE').length;
		const headApproved = committee.votes.some((vote) => vote.userId === committee.head && vote.decision === 'APPROVE');
		if (approveCount > committee.members.length / 2 && headApproved) {
			this.transition(cr, CrStatus.COMMITTEE_DECISION, CrAction.RESOLVE_COMMITTEE, user.id, at);
			this.transition(cr, CrStatus.APPROVED, CrAction.RESOLVE_COMMITTEE, user.id, at);
			committee.resolvedAt = at;
		} else if (committee.votes.length === committee.members.length) {
			this.transition(cr, CrStatus.COMMITTEE_DECISION, CrAction.RESOLVE_COMMITTEE, user.id, at);
			this.transition(cr, CrStatus.REJECTED, CrAction.RESOLVE_COMMITTEE, user.id, at);
			committee.resolvedAt = at;
		}
		return this.repo.save(cr);
	}

	returnToDraft(user: ReqUser, id: string, at: string): ChangeRequest {
		// TODO: PENDING_APPROVAL -> RETURNED -> editable as DRAFT; reset approval progress.
		if (!hasPolicy(user, 'cr_a_u') && !hasPolicy(user, 'cr_a_o') && !hasPolicy(user, 'cr_a_w'))
			throw Errors.forbidden('Cannot return to draft');
		const cr = this.getOrThrow(user, id);
		if (cr.status !== CrStatus.PENDING_APPROVAL) {
			throw Errors.validation('Change request is not in pending approval');
		}
		this.transition(cr, CrStatus.RETURNED, CrAction.RETURN, user.id, at);
		this.transition(cr, CrStatus.DRAFT, CrAction.RETURN, user.id, at);
		cr.approvals = [];
		if (cr.committee) {
			cr.committee.votes = [];
			cr.committee.resolvedAt = undefined;
		}
		return this.repo.save(cr);
	}

	reject(user: ReqUser, id: string, at: string): ChangeRequest {
		// TODO: legal transition to REJECTED (terminal); budget untouched; audit.
		if (!hasPolicy(user, 'cr_a_u') && !hasPolicy(user, 'cr_a_o') && !hasPolicy(user, 'cr_a_w')) throw Errors.forbidden('Cannot reject');
		const cr = this.getOrThrow(user, id);
		const singleApprover =
			cr.status === CrStatus.PENDING_APPROVAL && Math.abs(cr.totals.delta) <= COMMITTEE_DELTA_THRESHOLD;
		if (!singleApprover) {
			if (cr.status === CrStatus.COMMITTEE_VOTING || cr.status === CrStatus.COMMITTEE_DECISION) {
				throw Errors.validation('Committee CRs reject only via committee resolution');
			}
		}
		this.transition(cr, CrStatus.REJECTED, CrAction.REJECT, user.id, at);
		return this.repo.save(cr);
	}

	apply(user: ReqUser, id: string, at: string): ChangeRequest {
		// TODO: require APPROVED + cr_x_* policy; check budget.balance covers a positive delta else
		//       INSUFFICIENT_BUDGET; update budget, set APPLIED, audit. Recompute totals from the
		//       agreement.
		if (!hasPolicy(user, 'cr_x_u') && !hasPolicy(user, 'cr_x_o') && !hasPolicy(user, 'cr_x_w')) throw Errors.forbidden('Cannot apply');
		const cr = this.recomputeTotals(user, id);
		if (cr.status !== CrStatus.APPROVED) {
			throw Errors.validation('Change request is not approved');
		}
		const agreement = this.agreements.get(cr.agreementId);
		const budget = this.budgets.get(agreement.budgetId);
		if (!budget) throw Errors.notFound('Budget not found');
		const delta = cr.totals.delta;
		if (delta > 0 && budget.balance < delta) {
			throw Errors.insufficientBudget();
		}
		this.transition(cr, CrStatus.APPLIED, CrAction.APPLY, user.id, at);
		if (delta !== 0) {
			budget.booked = round2(budget.booked + delta);
			budget.balance = round2(budget.balance - delta);
		}
		return this.repo.save(cr);
	}

	/** Read a single CR. */
	get(user: ReqUser, id: string): ChangeRequest {
		return this.getOrThrow(user, id);
	}

	/** List the CRs this user is allowed to see. Honor the user's read scope (u/w/o). */
	list(user: ReqUser): ChangeRequest[] {
		// TODO: org scoping happens in the repo; narrow further by the caller's read scope.
		const scope = crReadScope(user);
		if (!scope) throw Errors.forbidden('Cannot list');
		const inOrg = this.repo.list(user);
		if (scope === 'o') return inOrg;
		if (scope === 'w') return inOrg.filter((cr) => user.workspaceIds.includes(cr.workspaceId));
		return inOrg.filter((cr) => cr.createdBy === user.id);
	}

	/** Recompute and persist totals for a CR (used by tests and before routing). Provided. */
	recomputeTotals(user: ReqUser, id: string): ChangeRequest {
		const cr = this.getOrThrow(user, id);
		const agreement = this.agreements.get(cr.agreementId);
		if (!agreement) throw Errors.notFound('Agreement not found');
		cr.totals = computeTotals(agreement, cr);
		return this.repo.save(cr);
	}
}
