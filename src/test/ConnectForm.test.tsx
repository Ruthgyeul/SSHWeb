// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { ConnectForm } from "@/components/ssh/ConnectForm";

afterEach(() => {
  localStorage.clear();
});

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

describe("ConnectForm saved profiles", () => {
  it("renders saved profiles and loads one into the fields (no password)", () => {
    localStorage.setItem(
      "sshweb.connectionProfiles",
      JSON.stringify([
        {
          id: "p1",
          host: "prod.example",
          port: 2222,
          username: "deploy",
          auth: "password",
          label: "prod",
        },
      ]),
    );

    render(<ConnectForm onConnect={() => {}} connecting={false} />);

    const chip = screen.getByRole("button", { name: "prod" });
    fireEvent.click(chip);

    expect((screen.getByLabelText("Host") as HTMLInputElement).value).toBe(
      "prod.example",
    );
    expect((screen.getByLabelText("Port") as HTMLInputElement).value).toBe(
      "2222",
    );
    expect((screen.getByLabelText("Username") as HTMLInputElement).value).toBe(
      "deploy",
    );
    expect((screen.getByLabelText("Password") as HTMLInputElement).value).toBe(
      "",
    );
  });

  it("saves the current connection identity (no password persisted)", () => {
    render(<ConnectForm onConnect={() => {}} connecting={false} />);

    fireEvent.change(screen.getByLabelText("Host"), {
      target: { value: "h.example" },
    });
    fireEvent.change(screen.getByLabelText("Username"), {
      target: { value: "root" },
    });
    fireEvent.change(screen.getByLabelText("Password"), {
      target: { value: "topsecret" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Save/ }));

    const stored = localStorage.getItem("sshweb.connectionProfiles") ?? "";
    expect(stored).toContain("h.example");
    expect(stored).toContain("root");
    // The secret must never be persisted.
    expect(stored).not.toContain("topsecret");
  });
});
