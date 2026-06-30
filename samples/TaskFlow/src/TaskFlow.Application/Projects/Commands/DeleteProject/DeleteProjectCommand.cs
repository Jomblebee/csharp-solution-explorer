using MediatR;

namespace TaskFlow.Application.Projects.Commands.DeleteProject;

public record DeleteProjectCommand(int Id) : IRequest;
