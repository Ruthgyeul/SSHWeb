// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ConnectForm } from "@/components/ssh/ConnectForm";

describe("ConnectForm initial values", () => {
  it("pre-fills host/port/user from `initial` but never the password", () => {
    render(
      <ConnectForm
        onConnect={() => {}}
        connecting={false}
        initial={{
          host: "h.example",
          port: "2222",
          username: "alice",
          auth: "password",
        }}
      />,
    );

    expect((screen.getByLabelText("Host") as HTMLInputElement).value).toBe(
      "h.example",
    );
    expect((screen.getByLabelText("Port") as HTMLInputElement).value).toBe(
      "2222",
    );
    expect((screen.getByLabelText("Username") as HTMLInputElement).value).toBe(
      "alice",
    );
    // The password is the one field a failed login clears.
    expect((screen.getByLabelText("Password") as HTMLInputElement).value).toBe(
      "",
    );
  });

  it("pre-fills key material for a key auth without a password field", () => {
    render(
      <ConnectForm
        onConnect={() => {}}
        connecting={false}
        initial={{
          host: "h.example",
          username: "bob",
          auth: "key",
          privateKey: "KEYDATA",
          passphrase: "pp",
        }}
      />,
    );

    expect(
      (screen.getByLabelText(/Private key/) as HTMLTextAreaElement).value,
    ).toBe("KEYDATA");
    expect(
      (screen.getByLabelText(/Key passphrase/) as HTMLInputElement).value,
    ).toBe("pp");
    expect(screen.queryByLabelText("Password")).toBeNull();
  });

  it("submits the retyped password with the pre-filled identity", () => {
    const onConnect = vi.fn();
    render(
      <ConnectForm
        onConnect={onConnect}
        connecting={false}
        initial={{ host: "h.example", port: "22", username: "alice" }}
      />,
    );

    fireEvent.change(screen.getByLabelText("Password"), {
      target: { value: "s3cret" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Connect/ }));

    expect(onConnect).toHaveBeenCalledWith(
      expect.objectContaining({
        host: "h.example",
        port: 22,
        username: "alice",
        password: "s3cret",
      }),
    );
  });

  it("defaults to empty fields with no `initial`", () => {
    render(<ConnectForm onConnect={() => {}} connecting={false} />);
    expect((screen.getByLabelText("Host") as HTMLInputElement).value).toBe("");
    expect((screen.getByLabelText("Port") as HTMLInputElement).value).toBe("22");
  });
});
