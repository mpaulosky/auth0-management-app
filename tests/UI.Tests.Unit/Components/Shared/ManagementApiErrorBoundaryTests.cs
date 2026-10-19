// ============================================
// Copyright (c) 2026. All rights reserved.
// File Name :     ManagementApiErrorBoundaryTests.cs
// Company :       mpaulosky
// Author :        Teqslamer
// Solution Name : Auth0ManagementApp
// Project Name :  UI.Tests.Unit
// =============================================

using AngleSharp.Dom;

using Microsoft.AspNetCore.Components;
using Microsoft.AspNetCore.Components.Web;
using Microsoft.Extensions.DependencyInjection;

using UI.Components.Shared;

namespace UI.Tests.Unit.Components.Shared;

public class ManagementApiErrorBoundaryTests : BunitContext
{
	private const string Message =
		"The app couldn't reach Auth0's Management API. Try again, or ask whoever runs the app to check its Auth0 Management settings.";

	public ManagementApiErrorBoundaryTests()
	{
		// The component reads RendererInfo, which bUnit requires a test to set. Static is the default; interactive tests override it.
		SetRendererInfo(new RendererInfo("Static", false));
	}

	[Fact]
	public void Render_ChildThrowsAfterAnAwait_ShowsTheManagementApiMessage()
	{
		// Arrange
		Switch fault = new() { Throw = true };

		// Act
		IRenderedComponent<ManagementApiErrorBoundary> cut = Render<ManagementApiErrorBoundary>(parameters => parameters
			.AddChildContent<AsyncFaultyChild>(child => child.Add(c => c.Fault, fault)));

		// Assert
		cut.WaitForAssertion(() => cut.Markup.Should().Contain(Message));
		cut.Markup.Should().NotContain("child ok");
	}

	[Fact]
	public void Render_ChildDoesNotThrow_ShowsTheChildAndNoMessage()
	{
		// Arrange
		Switch fault = new();

		// Act
		IRenderedComponent<ManagementApiErrorBoundary> cut = RenderBoundary(fault);

		// Assert
		cut.Markup.Should().Contain("child ok");
		cut.Markup.Should().NotContain("couldn't reach");
	}

	[Fact]
	public void Render_ChildThrows_ShowsTheManagementApiMessage()
	{
		// Arrange
		Switch fault = new() { Throw = true };

		// Act
		IRenderedComponent<ManagementApiErrorBoundary> cut = RenderBoundary(fault);

		// Assert
		cut.Markup.Should().Contain(Message);
		cut.Markup.Should().NotContain("child ok");
	}

	[Fact]
	public void Render_InteractiveAndChildThrows_TryAgainIsAButton()
	{
		// Arrange
		Switch fault = new() { Throw = true };
		SetRendererInfo(new RendererInfo("Server", true));

		// Act
		IRenderedComponent<ManagementApiErrorBoundary> cut = RenderBoundary(fault);

		// Assert
		cut.FindAll("button").Should().ContainSingle(b => b.TextContent.Contains("Try again", StringComparison.Ordinal));
	}

	[Fact]
	public void TryAgain_InteractiveAndClicked_RecoversAndRendersTheChildAgain()
	{
		// Arrange
		Switch fault = new() { Throw = true };
		SetRendererInfo(new RendererInfo("Server", true));
		IRenderedComponent<ManagementApiErrorBoundary> cut = RenderBoundary(fault);
		fault.Throw = false;

		// Act
		cut.FindAll("button").Single(b => b.TextContent.Contains("Try again", StringComparison.Ordinal)).Click();

		// Assert
		cut.Markup.Should().Contain("child ok");
		cut.Markup.Should().NotContain("couldn't reach");
	}

	[Fact]
	public void Render_UrlChangedAfterAChildThrew_RecoversAndRendersTheChildAgain()
	{
		// Arrange
		Switch fault = new() { Throw = true };
		SetRendererInfo(new RendererInfo("Server", true));
		NavigationManager navigation = Services.GetRequiredService<NavigationManager>();
		navigation.NavigateTo("http://localhost/admin/users?user=abc");
		IRenderedComponent<ManagementApiErrorBoundary> cut = RenderBoundary(fault);
		fault.Throw = false;
		navigation.NavigateTo("http://localhost/admin/users?user=def");

		// Act
		RerenderBoundary(cut, fault);

		// Assert
		cut.Markup.Should().Contain("child ok");
		cut.Markup.Should().NotContain("couldn't reach");
	}

	[Fact]
	public void Render_SameUrlAfterAChildThrew_KeepsShowingTheManagementApiMessage()
	{
		// Arrange
		Switch fault = new() { Throw = true };
		SetRendererInfo(new RendererInfo("Server", true));
		NavigationManager navigation = Services.GetRequiredService<NavigationManager>();
		navigation.NavigateTo("http://localhost/admin/users?user=abc");
		IRenderedComponent<ManagementApiErrorBoundary> cut = RenderBoundary(fault);
		fault.Throw = false;

		// Act
		RerenderBoundary(cut, fault);

		// Assert
		cut.Markup.Should().Contain(Message);
		cut.Markup.Should().NotContain("child ok");
	}

	[Fact]
	public void Render_StaticAndChildThrows_TryAgainIsALinkToTheCurrentUrlNotAButton()
	{
		// Arrange
		Switch fault = new() { Throw = true };
		SetRendererInfo(new RendererInfo("Static", false));
		NavigationManager navigation = Services.GetRequiredService<NavigationManager>();
		navigation.NavigateTo("http://localhost/admin");

		// Act
		IRenderedComponent<ManagementApiErrorBoundary> cut = RenderBoundary(fault);

		// Assert
		cut.FindAll("button").Should().BeEmpty();
		IElement link = cut.FindAll("a").Single(a => a.TextContent.Contains("Try again", StringComparison.Ordinal));
		new Uri(new Uri(navigation.Uri), link.GetAttribute("href")).AbsoluteUri.Should().Be(new Uri(navigation.Uri).AbsoluteUri);
	}

	private IRenderedComponent<ManagementApiErrorBoundary> RenderBoundary(Switch fault) =>
		Render<ManagementApiErrorBoundary>(parameters => parameters
			.AddChildContent<FaultyChild>(child => child.Add(c => c.Fault, fault)));

	// A new ChildContent fragment, as the boundary gets each time the page around it renders.
	private static void RerenderBoundary(IRenderedComponent<ManagementApiErrorBoundary> cut, Switch fault) =>
		cut.Render(parameters => parameters
			.AddChildContent<FaultyChild>(child => child.Add(c => c.Fault, fault)));

	private sealed class Switch
	{
		public bool Throw { get; set; }
	}

	private sealed class FaultyChild : ComponentBase
	{
		[Parameter]
		public Switch Fault { get; set; } = new();

		protected override void BuildRenderTree(Microsoft.AspNetCore.Components.Rendering.RenderTreeBuilder builder)
		{
			if (Fault.Throw)
			{
				throw new InvalidOperationException("Management API unreachable");
			}

			builder.AddContent(0, "child ok");
		}
	}

	// Throws after an await, as a page does when its Management API call fails during OnInitializedAsync.
	private sealed class AsyncFaultyChild : ComponentBase
	{
		[Parameter]
		public Switch Fault { get; set; } = new();

		protected override async Task OnInitializedAsync()
		{
			await Task.Yield();
			if (Fault.Throw)
			{
				throw new InvalidOperationException("Management API unreachable");
			}
		}

		protected override void BuildRenderTree(Microsoft.AspNetCore.Components.Rendering.RenderTreeBuilder builder)
		{
			builder.AddContent(0, "child ok");
		}
	}
}
