from brutus.ticket_intake import compile_ticket_intake


def _history(*turns):
    return [{"role": role, "content": content} for role, content in turns]


def test_complete_labelled_ticket_contract_is_reconstructed_from_user_turns():
    intake = compile_ticket_intake(_history(
        ("user", "new ticket: title: Voice action intake\noutcome: Draft tickets from voice\ntarget: Brutus voice surface\npremise: Text tool calls are unreliable\nscope: Explicit labelled contracts only\npreservation: Existing approval gate\nacceptance: A draft artifact exists; no Linear mutation before yes\ndelivery: test and deploy"),
    ))

    assert intake.ready
    assert intake.args()["title"] == "Voice action intake"
    assert intake.args()["acceptance"] == (
        "A draft artifact exists", "no Linear mutation before yes",
    )


def test_incomplete_ticket_never_invents_missing_contract_fields():
    intake = compile_ticket_intake(_history(("user", "draft a ticket: outcome: Make voice useful")))

    assert intake.requested
    assert intake.missing == ("target", "premise", "scope", "preservation", "acceptance", "delivery")


def test_unrelated_follow_up_does_not_reopen_an_old_ticket_request():
    intake = compile_ticket_intake(_history(
        ("user", "draft a ticket: outcome: Something"),
        ("assistant", "What is the target?"),
        ("user", "what needs me now?"),
    ))

    assert intake.requested is False
