// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TransferProgress } from "@/components/ssh/TransferProgress";
import type { DownloadItem, UploadItem } from "@/components/ssh/FileBrowser";

const noop = () => {};
const base = {
  uploads: [] as UploadItem[],
  downloads: [] as DownloadItem[],
  onCancelUpload: noop,
  onCancelAllUploads: noop,
  onResumeUpload: noop,
  onCancelDownload: noop,
};

describe("TransferProgress", () => {
  it("renders nothing when there are no transfers", () => {
    const { container } = render(<TransferProgress {...base} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("shows a single upload row without the aggregate bar", () => {
    render(
      <TransferProgress
        {...base}
        uploads={[{ path: "/dst/a.bin", name: "a.bin", sent: 50, total: 100 }]}
      />,
    );
    expect(screen.getByText("↑ a.bin")).toBeInTheDocument();
    expect(screen.getByText("50%")).toBeInTheDocument();
    expect(screen.queryByText(/Uploading/)).not.toBeInTheDocument();
  });

  it("aggregates a batch and collapses queued files into a count", () => {
    render(
      <TransferProgress
        {...base}
        uploads={[
          { path: "/a", name: "a", sent: 100, total: 100, status: "uploading" },
          { path: "/b", name: "b", sent: 0, total: 100, status: "queued" },
        ]}
      />,
    );
    expect(screen.getByText(/Uploading 2 files/)).toBeInTheDocument();
    expect(screen.getByText(/1 queued/)).toBeInTheDocument();
    // The active file gets its own row; the queued one does not.
    expect(screen.getByText("↑ a")).toBeInTheDocument();
    expect(screen.queryByText("↑ b")).not.toBeInTheDocument();
  });

  it("offers Resume for an interrupted upload", () => {
    const onResumeUpload = vi.fn();
    render(
      <TransferProgress
        {...base}
        onResumeUpload={onResumeUpload}
        uploads={[
          {
            path: "/x",
            name: "x",
            sent: 10,
            total: 100,
            status: "interrupted",
          },
        ]}
      />,
    );
    expect(screen.getByText("interrupted")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Resume" }));
    expect(onResumeUpload).toHaveBeenCalledWith("/x");
  });

  it("cancels an upload and the whole batch", () => {
    const onCancelUpload = vi.fn();
    const onCancelAllUploads = vi.fn();
    render(
      <TransferProgress
        {...base}
        onCancelUpload={onCancelUpload}
        onCancelAllUploads={onCancelAllUploads}
        uploads={[
          { path: "/a", name: "a", sent: 1, total: 2, status: "uploading" },
          { path: "/b", name: "b", sent: 1, total: 2, status: "uploading" },
        ]}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Cancel upload a" }));
    expect(onCancelUpload).toHaveBeenCalledWith("/a");
    fireEvent.click(screen.getByRole("button", { name: "Cancel all" }));
    expect(onCancelAllUploads).toHaveBeenCalledTimes(1);
  });

  it("renders a download row and cancels it", () => {
    const onCancelDownload = vi.fn();
    render(
      <TransferProgress
        {...base}
        onCancelDownload={onCancelDownload}
        downloads={[
          { path: "/dl/big.iso", name: "big.iso", received: 25, total: 100 },
        ]}
      />,
    );
    expect(screen.getByText("↓ big.iso")).toBeInTheDocument();
    expect(screen.getByText("25%")).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "Cancel download big.iso" }),
    );
    expect(onCancelDownload).toHaveBeenCalledWith("/dl/big.iso");
  });
});
