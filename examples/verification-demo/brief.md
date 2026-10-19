# Verify a disposable request approval flow

An Editor creates a request for three items priced at 1,400 cents each. The browser
must show a saved total of 4,200 cents, and a fresh API read must match every saved
field, including owner and identifier. The Editor cannot approve the request.

A distinct Reviewer can approve a draft exactly once. Approval must preserve the
request's identity, ownership, item count, unit price and total. A repeated approval
returns 409 and leaves every saved field unchanged. An anonymous request receives 401.

Create only uniquely marked records owned by this run. Capture their identifiers
before assertions can fail, delete only those records in finally-backed cleanup, and
verify their absence. Keep authentication and screenshots out of retained output.
Use dedicated generated accounts against the loopback demo app only.
