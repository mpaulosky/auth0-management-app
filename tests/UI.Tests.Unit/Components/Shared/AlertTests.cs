// ============================================
// Copyright (c) 2026. All rights reserved.
// File Name :     AlertTests.cs
// Company :       mpaulosky
// Author :        Teqslamer
// Solution Name : Auth0ManagementApp
// Project Name :  UI.Tests.Unit
// =============================================

using AngleSharp.Dom;

using UI.Components.Shared;

namespace UI.Tests.Unit.Components.Shared;

public class AlertTests : BunitContext
{
	[Theory]
	[InlineData(AlertTone.Error)]
	[InlineData(AlertTone.Warning)]
	public void Render_AnyTone_HasAlertRoleAndShowsChildContent(AlertTone tone)
	{
		// Arrange

		// Act
		IRenderedComponent<Alert> cut = Render<Alert>(parameters => parameters
			.Add(c => c.Tone, tone)
			.Add(c => c.ChildContent, "Something failed"));

		// Assert
		IElement alert = cut.Find("[role='alert']");
		alert.TextContent.Should().Contain("Something failed");
	}

	[Theory]
	[InlineData(AlertTone.Error, "red", "amber")]
	[InlineData(AlertTone.Warning, "amber", "red")]
	public void Render_Tone_UsesItsFixedHueWithDarkVariants(AlertTone tone, string hue, string otherHue)
	{
		// Arrange

		// Act
		IRenderedComponent<Alert> cut = Render<Alert>(parameters => parameters
			.Add(c => c.Tone, tone)
			.Add(c => c.ChildContent, "Something failed"));

		// Assert
		string classes = cut.Find("[role='alert']").GetAttribute("class") ?? string.Empty;
		classes.Should().Contain($"-{hue}-");
		classes.Should().Contain($"dark:text-{hue}-");
		classes.Should().NotContain($"-{otherHue}-");
	}

	[Theory]
	[InlineData(AlertTone.Error)]
	[InlineData(AlertTone.Warning)]
	public void Render_AnyTone_UsesNoAccentColour(AlertTone tone)
	{
		// Arrange

		// Act
		IRenderedComponent<Alert> cut = Render<Alert>(parameters => parameters
			.Add(c => c.Tone, tone)
			.Add(c => c.ChildContent, "Something failed"));

		// Assert
		(cut.Find("[role='alert']").GetAttribute("class") ?? string.Empty).Should().NotContain("accent-");
	}
}
